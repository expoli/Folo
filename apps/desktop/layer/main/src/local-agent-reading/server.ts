/**
 * The loopback MCP endpoint.
 *
 * The endpoint speaks the Model Context Protocol over Streamable HTTP, so an external agent needs
 * no Folo-specific glue: it registers the URL and reads tools. Everything before the protocol layer
 * is a guard, because this socket is reachable by every process on the machine:
 *
 * - it binds to `127.0.0.1` only, on a fixed port, and refuses to start when the port is taken;
 * - the `Host` header must be the loopback authority, which defeats DNS rebinding, and any request
 *   carrying an `Origin` header is refused, so a web page cannot reach the endpoint;
 * - it serves one path with `POST` only, requires the dedicated bearer token, and answers 401
 *   without the token instead of leaking whether the app is signed in;
 * - request size, request rate and concurrent tool calls are bounded.
 *
 * The MCP session is stateless: scans live in the service, not in a transport session, so a client
 * that reconnects does not lose its place and no per-connection state has to be reaped.
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { createServer } from "node:http"

import type {
  LocalAgentReadingBeginScanArgs,
  LocalAgentReadingContentsArgs,
  LocalAgentReadingContentsResult,
  LocalAgentReadingListArgs,
  LocalAgentReadingScanPageResult,
  LocalAgentReadingScanSummary,
  LocalAgentReadingStatusResult,
} from "@follow/shared/local-agent-reading"
import {
  LOCAL_AGENT_READING_CONTRACT_VERSION,
  LOCAL_AGENT_READING_ENDPOINT_PATH,
  LOCAL_AGENT_READING_HOST,
  LOCAL_AGENT_READING_LIMITS,
  LOCAL_AGENT_READING_PORT,
  LOCAL_AGENT_READING_SERVICE_NAME,
  LOCAL_AGENT_READING_TOOL_INFO,
  localAgentReadingBeginScanArgsSchema,
  localAgentReadingContentsArgsSchema,
  localAgentReadingEndpointUrl,
  localAgentReadingListArgsSchema,
} from "@follow/shared/local-agent-reading"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"

import { tokensMatch } from "./token"

/** A tool answer: either the payload or a named refusal the agent can act on. */
export type ToolAnswer<T> =
  { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

export interface LocalAgentReadingToolHandlers {
  status(): Promise<LocalAgentReadingStatusResult>
  beginScan(args: LocalAgentReadingBeginScanArgs): Promise<ToolAnswer<LocalAgentReadingScanSummary>>
  listEntries(args: LocalAgentReadingListArgs): Promise<ToolAnswer<LocalAgentReadingScanPageResult>>
  getContents(
    args: LocalAgentReadingContentsArgs,
  ): Promise<ToolAnswer<LocalAgentReadingContentsResult>>
}

export interface LoopbackServerOptions {
  tools: LocalAgentReadingToolHandlers
  /** Bearer token currently issued; `null` refuses every request. */
  getToken: () => string | null
  port?: number
  log?: (line: string) => void
  now?: () => number
  limits?: {
    maxRequestBodyBytes: number
    requestsPerMinute: number
    maxConcurrentToolCalls: number
  }
}

export interface LocalAgentReadingServerHandle {
  start(): Promise<{ ok: true; url: string } | { ok: false; message: string }>
  stop(): Promise<void>
  isListening(): boolean
  endpoint(): string | null
  port(): number | null
}

const RATE_WINDOW_MS = 60_000
/** A tool call may enumerate for a minute, so the socket timeout has to outlast it. */
const REQUEST_TIMEOUT_MS = 180_000
const HEADERS_TIMEOUT_MS = 20_000

const AUTHORIZATION_PATTERN = /^Bearer\s+(\S+)$/i

interface Refusal {
  status: number
  code: string
  message: string
  headers?: Record<string, string>
}

const sendJson = (res: ServerResponse, status: number, body: unknown, headers = {}) => {
  const payload = Buffer.from(JSON.stringify(body), "utf8")
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.byteLength),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  })
  res.end(payload)
}

const refuse = (res: ServerResponse, refusal: Refusal) => {
  sendJson(
    res,
    refusal.status,
    { error: { code: refusal.code, message: refusal.message } },
    refusal.headers,
  )
}

const toolPayload = <T>(answer: ToolAnswer<T>) =>
  answer.ok
    ? {
        content: [{ type: "text" as const, text: JSON.stringify(answer.data) }],
      }
    : {
        isError: true as const,
        content: [{ type: "text" as const, text: JSON.stringify({ error: answer.error }) }],
      }

/**
 * Registers the four read-only tools.
 *
 * The input schemas are the shared ones, so what the agent sees in `tools/list`, what the protocol
 * validates and what the service re-checks cannot drift apart. There is deliberately no tool that
 * changes read state.
 */
export const registerLocalAgentReadingTools = (
  server: McpServer,
  tools: LocalAgentReadingToolHandlers,
) => {
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }

  server.registerTool(
    "folo_get_status",
    {
      ...LOCAL_AGENT_READING_TOOL_INFO.folo_get_status,
      annotations,
    },
    async () => {
      try {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(await tools.status()) }],
        }
      } catch (error) {
        return toolPayload({
          ok: false,
          error: {
            code: "STATUS_FAILED",
            message: error instanceof Error ? error.message : "The status could not be read",
          },
        })
      }
    },
  )

  server.registerTool(
    "folo_begin_unread_scan",
    {
      ...LOCAL_AGENT_READING_TOOL_INFO.folo_begin_unread_scan,
      inputSchema: {
        scope: localAgentReadingBeginScanArgsSchema.shape.scope,
      },
      annotations,
    },
    async (args) => toolPayload(await tools.beginScan(args as LocalAgentReadingBeginScanArgs)),
  )

  server.registerTool(
    "folo_list_scan_entries",
    {
      ...LOCAL_AGENT_READING_TOOL_INFO.folo_list_scan_entries,
      inputSchema: {
        scanId: localAgentReadingListArgsSchema.shape.scanId,
        cursor: localAgentReadingListArgsSchema.shape.cursor,
        limit: localAgentReadingListArgsSchema.shape.limit,
      },
      annotations,
    },
    async (args) => toolPayload(await tools.listEntries(args as LocalAgentReadingListArgs)),
  )

  server.registerTool(
    "folo_get_entry_contents",
    {
      ...LOCAL_AGENT_READING_TOOL_INFO.folo_get_entry_contents,
      inputSchema: {
        scanId: localAgentReadingContentsArgsSchema.shape.scanId,
        entryIds: localAgentReadingContentsArgsSchema.shape.entryIds,
        mode: localAgentReadingContentsArgsSchema.shape.mode,
        cursor: localAgentReadingContentsArgsSchema.shape.cursor,
      },
      annotations,
    },
    async (args) => toolPayload(await tools.getContents(args as LocalAgentReadingContentsArgs)),
  )
}

/** Reads the request body, refusing anything larger than the configured limit. */
const readBody = async (
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; refusal: Refusal }> => {
  const declared = Number(req.headers["content-length"] ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    return {
      ok: false,
      refusal: {
        status: 413,
        code: "request_too_large",
        message: `The request body may not exceed ${maxBytes} bytes`,
      },
    }
  }

  const chunks: Buffer[] = []
  let size = 0

  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
      size += buffer.byteLength
      if (size > maxBytes) {
        return {
          ok: false,
          refusal: {
            status: 413,
            code: "request_too_large",
            message: `The request body may not exceed ${maxBytes} bytes`,
          },
        }
      }
      chunks.push(buffer)
    }
  } catch {
    return {
      ok: false,
      refusal: { status: 400, code: "request_unreadable", message: "The request body was lost" },
    }
  }

  const text = Buffer.concat(chunks).toString("utf8")
  if (!text.trim()) {
    return {
      ok: false,
      refusal: { status: 400, code: "invalid_request", message: "The request body is empty" },
    }
  }

  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return {
      ok: false,
      refusal: { status: 400, code: "invalid_json", message: "The request body is not JSON" },
    }
  }
}

export const createLocalAgentReadingServer = (
  options: LoopbackServerOptions,
): LocalAgentReadingServerHandle => {
  const log = options.log ?? (() => {})
  const now = options.now ?? Date.now
  const port = options.port ?? LOCAL_AGENT_READING_PORT
  const limits = options.limits ?? {
    maxRequestBodyBytes: LOCAL_AGENT_READING_LIMITS.maxRequestBodyBytes,
    requestsPerMinute: LOCAL_AGENT_READING_LIMITS.requestsPerMinute,
    maxConcurrentToolCalls: LOCAL_AGENT_READING_LIMITS.maxConcurrentToolCalls,
  }

  let server: Server | null = null
  let listening = false
  let activeCalls = 0
  let requestTimes: number[] = []
  /** Port actually bound; differs from `port` only when tests ask for an ephemeral one. */
  let boundPort = port

  /** The only authority a request may name in its `Host` header. */
  const allowedHost = () => `${LOCAL_AGENT_READING_HOST}:${boundPort}`

  const rateLimited = (): number | null => {
    const cutoff = now() - RATE_WINDOW_MS
    requestTimes = requestTimes.filter((time) => time > cutoff)
    if (requestTimes.length >= limits.requestsPerMinute) {
      const oldest = requestTimes[0] ?? now()
      return Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - now()) / 1000))
    }
    requestTimes.push(now())
    return null
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host
    if (!host || host !== allowedHost()) {
      // A rebound DNS name arrives with its own Host and is refused here.
      refuse(res, { status: 403, code: "forbidden_host", message: "Unexpected Host header" })
      return
    }
    if (req.headers.origin !== undefined) {
      // Browsers always send Origin for cross-origin POSTs; native agents do not send it at all.
      refuse(res, {
        status: 403,
        code: "forbidden_origin",
        message: "Browser requests are not accepted by this endpoint",
      })
      return
    }

    const retryAfter = rateLimited()
    if (retryAfter !== null) {
      refuse(res, {
        status: 429,
        code: "rate_limited",
        message: "Too many requests",
        headers: { "retry-after": String(retryAfter) },
      })
      return
    }

    const url = new URL(req.url ?? "/", `http://${host}`)
    if (url.pathname !== LOCAL_AGENT_READING_ENDPOINT_PATH) {
      refuse(res, { status: 404, code: "not_found", message: "Unknown path" })
      return
    }
    if (req.method !== "POST") {
      refuse(res, {
        status: 405,
        code: "method_not_allowed",
        message: "Only POST is served",
        headers: { allow: "POST" },
      })
      return
    }

    const token = options.getToken()
    const authorization = req.headers.authorization
    const presented =
      typeof authorization === "string" ? AUTHORIZATION_PATTERN.exec(authorization) : null
    if (!token || !presented?.[1] || !tokensMatch(token, presented[1])) {
      refuse(res, {
        status: 401,
        code: "unauthorized",
        message: "A valid access token is required",
        headers: { "www-authenticate": 'Bearer realm="folo"' },
      })
      return
    }

    const contentType = req.headers["content-type"] ?? ""
    if (!contentType.toLowerCase().includes("application/json")) {
      refuse(res, {
        status: 415,
        code: "unsupported_media_type",
        message: "The request body must be JSON",
      })
      return
    }

    if (activeCalls >= limits.maxConcurrentToolCalls) {
      refuse(res, {
        status: 429,
        code: "busy",
        message: "Another tool call is still running; retry shortly",
        headers: { "retry-after": "1" },
      })
      return
    }

    const body = await readBody(req, limits.maxRequestBodyBytes)
    if (!body.ok) {
      refuse(res, body.refusal)
      return
    }

    const mcp = new McpServer(
      {
        name: LOCAL_AGENT_READING_SERVICE_NAME,
        version: String(LOCAL_AGENT_READING_CONTRACT_VERSION),
      },
      { maxToolInputElements: 1000 },
    )
    registerLocalAgentReadingTools(mcp, options.tools)

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // A JSON answer instead of an event stream: the tools answer in one piece.
      enableJsonResponse: true,
    })

    activeCalls += 1
    const release = () => {
      activeCalls = Math.max(0, activeCalls - 1)
    }

    res.on("close", () => {
      release()
      void transport.close().catch(() => {})
      void mcp.close().catch(() => {})
    })

    try {
      await mcp.connect(transport)
      await transport.handleRequest(req, res, body.value)
    } catch (error) {
      log(`[local-agent-reading] request failed: ${String(error)}`)
      if (!res.headersSent) {
        refuse(res, { status: 500, code: "internal_error", message: "The tool call failed" })
      }
    }
  }

  return {
    async start() {
      if (server && listening) {
        return { ok: true, url: localAgentReadingEndpointUrl(boundPort) }
      }

      const created = createServer((req, res) => {
        void handle(req, res)
      })
      created.requestTimeout = REQUEST_TIMEOUT_MS
      created.headersTimeout = HEADERS_TIMEOUT_MS
      created.keepAliveTimeout = 5_000

      const started = await new Promise<{ ok: true } | { ok: false; message: string }>(
        (resolve) => {
          const onError = (error: Error) => {
            created.removeListener("listening", onListening)
            resolve({ ok: false, message: error.message })
          }
          const onListening = () => {
            created.removeListener("error", onError)
            resolve({ ok: true })
          }

          created.once("error", onError)
          created.once("listening", onListening)
          created.listen(port, LOCAL_AGENT_READING_HOST)
        },
      )

      if (!started.ok) {
        created.close()
        log(
          `[local-agent-reading] cannot listen on ${LOCAL_AGENT_READING_HOST}:${port}: ${started.message}`,
        )
        return { ok: false, message: started.message }
      }

      const address = created.address()
      boundPort = typeof address === "object" && address ? address.port : port

      server = created
      listening = true
      log(`[local-agent-reading] listening on ${LOCAL_AGENT_READING_HOST}:${boundPort}`)
      return { ok: true, url: localAgentReadingEndpointUrl(boundPort) }
    },

    async stop() {
      const current = server
      server = null
      listening = false
      activeCalls = 0
      requestTimes = []

      if (!current) return
      await new Promise<void>((resolve) => {
        current.close(() => resolve())
        // In-flight tool calls must not keep the app from quitting.
        current.closeAllConnections?.()
      })
    },

    isListening: () => listening,

    endpoint: () => (listening ? localAgentReadingEndpointUrl(boundPort) : null),

    port: () => (listening ? boundPort : null),
  }
}
