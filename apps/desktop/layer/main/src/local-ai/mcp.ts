/**
 * The user's own MCP services, as tools of the chat loop.
 *
 * Only what a connection needs comes across from the renderer, and nothing outlives the request:
 * connections open once at the start of a chat, are shared by all of its tool calls, and are closed
 * when the answer is finished. Nothing is cached between chats, so a service the user just disabled
 * or re-authenticated is read as it is now.
 *
 * A service that cannot be reached is skipped, not fatal: one broken endpoint must not cost the
 * user the answer. Its tools simply are not offered.
 */
import type { LocalAIMcpService } from "@follow/shared/local-ai-mcp"
import { LOCAL_AI_MCP_LIMITS, parseLocalAIMcpServices } from "@follow/shared/local-ai-mcp"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import type { ToolSet } from "ai"
import { jsonSchema, tool } from "ai"

const CLIENT_INFO = { name: "folo-desktop", version: "1.0" }

/** The part of an MCP tool this module reads; extra fields a server sends are ignored. */
export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: { readOnlyHint?: boolean }
}

interface McpToolContent {
  type: string
  text?: string
  /** A resource block: only its text is readable, bytes have no meaning to the model. */
  resource?: { text?: string }
}

interface McpToolResult {
  content?: McpToolContent[]
  structuredContent?: unknown
  isError?: boolean
}

/** One open connection, reduced to what the loop does with it. Tests substitute this. */
export interface McpConnection {
  listTools(): Promise<{ tools: McpToolInfo[] }>
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<McpToolResult>
  close(): Promise<void>
}

export interface LocalAIMcpTools {
  tools: ToolSet
  /** Closes every connection this request opened. Safe to call more than once. */
  close: () => Promise<void>
}

export interface CreateLocalAIMcpToolsOptions {
  /** Chromium's network stack, so the app's proxy settings apply as they do elsewhere. */
  fetch?: typeof globalThis.fetch
  /** Test seam: a connection factory instead of a real transport. */
  connect?: (service: LocalAIMcpService) => Promise<McpConnection>
  signal?: AbortSignal
  log?: (line: string) => void
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const withTimeout = <T>(work: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })

/**
 * What a server answered, read defensively: the payload is remote data, so a block that does not
 * match the shape the client promises must not throw away the rest of the answer.
 *
 * A resource block carries either text or bytes; bytes have nothing to say to the model, so they
 * arrive as a bare `[resource]` marker instead of as a base64 blob.
 */
const toToolResult = (raw: unknown): McpToolResult => {
  const record = (raw ?? {}) as {
    content?: unknown
    structuredContent?: unknown
    isError?: unknown
  }
  const content: McpToolContent[] = []

  for (const item of Array.isArray(record.content) ? record.content : []) {
    const block = (item ?? {}) as { type?: unknown; text?: unknown; resource?: { text?: unknown } }
    const type = typeof block.type === "string" ? block.type : "unknown"
    const text =
      typeof block.text === "string"
        ? block.text
        : typeof block.resource?.text === "string"
          ? block.resource.text
          : undefined
    content.push(text === undefined ? { type } : { type, text })
  }

  return { content, structuredContent: record.structuredContent, isError: record.isError === true }
}

const connectService = async (
  service: LocalAIMcpService,
  fetch?: typeof globalThis.fetch,
): Promise<McpConnection> => {
  const url = new URL(service.url)
  const requestInit: RequestInit = service.headers ? { headers: service.headers } : {}
  // The SSE transport streams through `EventSource`, which takes no custom fetch; its request
  // headers still come from `requestInit`.
  const transport =
    service.transportType === "sse"
      ? new SSEClientTransport(url, { requestInit })
      : new StreamableHTTPClientTransport(url, { requestInit, ...(fetch ? { fetch } : {}) })

  const client = new Client(CLIENT_INFO, { capabilities: {} })
  await client.connect(transport)

  return {
    listTools: () => client.listTools(),
    callTool: async (params, options) =>
      toToolResult(await client.callTool(params, CallToolResultSchema, options)),
    close: () => client.close(),
  }
}

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24) || "service"

/**
 * The name the model sees. Provider tool names allow `[a-zA-Z0-9_-]` and at most 64 characters, so
 * the service names are reduced to a slug and the whole thing is truncated rather than rejected.
 */
const toolNameFor = (service: LocalAIMcpService, toolName: string, used: Set<string>) => {
  const base = `mcp__${slug(service.name || service.id)}__${toolName.replace(/[^\w-]/g, "_")}`
  let name = base.slice(0, 64)
  let suffix = 2
  while (used.has(name)) {
    const tail = `_${suffix}`
    name = `${base.slice(0, 64 - tail.length)}${tail}`
    suffix += 1
  }
  used.add(name)

  return name
}

const describeTool = (service: LocalAIMcpService, description?: string) => {
  const text = (description ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, LOCAL_AI_MCP_LIMITS.descriptionChars)
  return text ? `${text} (from ${service.name})` : `A tool of ${service.name}`
}

/** Flattens what a server answered into the text the model reads. */
const resultText = (result: McpToolResult) => {
  const parts: string[] = []
  for (const item of result.content ?? []) {
    if (typeof item.text === "string") parts.push(item.text)
    else if (typeof item.resource?.text === "string") parts.push(item.resource.text)
    else parts.push(`[${item.type}]`)
  }
  if (result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent))
  }

  const text = parts.join("\n").trim()
  const limit = LOCAL_AI_MCP_LIMITS.resultChars
  // A server decides how much it returns; the model's context does not grow with it.
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`
}

const callServiceTool = async (
  connection: McpConnection,
  toolName: string,
  args: unknown,
): Promise<unknown> => {
  const result = await connection.callTool(
    {
      name: toolName,
      arguments: (args ?? {}) as Record<string, unknown>,
    },
    { timeout: LOCAL_AI_MCP_LIMITS.callTimeoutMs },
  )

  const text = resultText(result)
  return result.isError ? { error: text || "the service reported an error" } : text
}

export const createLocalAIMcpTools = async (
  rawServices: unknown,
  options: CreateLocalAIMcpToolsOptions = {},
): Promise<LocalAIMcpTools> => {
  const services = parseLocalAIMcpServices(rawServices)
  const log = options.log ?? (() => {})
  const connect =
    options.connect ?? ((service: LocalAIMcpService) => connectService(service, options.fetch))

  if (services.length === 0) {
    return { tools: {}, close: async () => {} }
  }

  const opened = await Promise.all(
    services.map(async (service) => {
      let connection: McpConnection | null = null
      try {
        connection = await withTimeout(
          connect(service),
          LOCAL_AI_MCP_LIMITS.connectTimeoutMs,
          `${service.name} connect`,
        )
        const listed = await withTimeout(
          connection.listTools(),
          LOCAL_AI_MCP_LIMITS.connectTimeoutMs,
          `${service.name} tools`,
        )
        return { service, connection, listed: listed.tools ?? [] }
      } catch (error) {
        log(`[local-ai] mcp: ${service.name} unavailable: ${message(error)}`)
        await connection?.close().catch(() => {})
        return null
      }
    }),
  )

  const live = opened.filter((entry) => entry !== null)
  const tools: ToolSet = {}
  const usedNames = new Set<string>()
  let droppedTools = 0

  for (const { service, connection, listed } of live) {
    for (const info of listed) {
      // The settings offer write tools as well; the loop does not, so the list is filtered rather
      // than trusted. A server that annotates nothing exposes nothing.
      if (info.annotations?.readOnlyHint !== true) continue
      if (Object.keys(tools).length >= LOCAL_AI_MCP_LIMITS.maxTools) {
        droppedTools += 1
        continue
      }

      tools[toolNameFor(service, info.name, usedNames)] = tool({
        description: describeTool(service, info.description),
        inputSchema: jsonSchema(
          (info.inputSchema ?? { type: "object", properties: {} }) as Parameters<
            typeof jsonSchema
          >[0],
        ),
        execute: async (args) => callServiceTool(connection, info.name, args),
      })
    }
  }

  if (droppedTools > 0) {
    log(
      `[local-ai] mcp: ${droppedTools} tool(s) left out, the limit is ${LOCAL_AI_MCP_LIMITS.maxTools}`,
    )
  }
  if (live.length > 0) {
    log(
      `[local-ai] mcp: ${Object.keys(tools).length} read-only tool(s) from ${live.length} service(s)`,
    )
  }

  let closed = false
  return {
    tools,
    close: async () => {
      if (closed) return
      closed = true
      await Promise.allSettled(live.map(({ connection }) => connection.close()))
    },
  }
}
