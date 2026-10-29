/**
 * The real transport path: a Streamable HTTP MCP server on loopback, reached through the same
 * client, headers and tool filtering the app uses. The unit tests substitute the connection; this
 * one proves the substitution is faithful — the read-only filter, the naming and a call all work
 * against a server that speaks the protocol.
 */
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import type { ToolSet } from "ai"
import { afterEach, describe, expect, test } from "vitest"
import { z } from "zod"

import { createLocalAIMcpTools } from "./mcp"

interface TestServer {
  url: string
  /** Headers the server saw on the tool call, so the request headers can be asserted. */
  seenAuthorization: () => string | null
  close: () => Promise<void>
}

const startServer = async (): Promise<TestServer> => {
  let authorization: string | null = null

  const http = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer))
      const raw = Buffer.concat(chunks).toString("utf8")
      const body = raw ? JSON.parse(raw) : undefined
      if (typeof req.headers.authorization === "string") {
        authorization = req.headers.authorization
      }

      const server = new McpServer({ name: "test-mcp", version: "1.0" })
      server.registerTool(
        "search_notes",
        {
          title: "Search notes",
          description: "Looks up notes by query",
          inputSchema: { query: z.string() },
          annotations: { readOnlyHint: true },
        },
        async (args) => ({
          content: [{ type: "text" as const, text: `notes about ${args.query}` }],
        }),
      )
      server.registerTool(
        "create_note",
        {
          title: "Create note",
          description: "Writes a note",
          inputSchema: { text: z.string() },
          annotations: { readOnlyHint: false },
        },
        async () => ({ content: [{ type: "text" as const, text: "created" }] }),
      )

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      res.on("close", () => {
        void transport.close().catch(() => {})
        void server.close().catch(() => {})
      })

      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end()
    })
  })

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const { port } = http.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seenAuthorization: () => authorization,
    close: () =>
      new Promise<void>((resolve) => {
        http.close(() => resolve())
      }),
  }
}

const run = async (tools: ToolSet, name: string, input: unknown): Promise<unknown> => {
  const entry = tools[name] as unknown as {
    execute?: (input: unknown, options: unknown) => Promise<unknown>
  }
  if (!entry?.execute) throw new Error(`${name} has no execute function`)
  return await entry.execute(input, { toolCallId: "call-1", messages: [] })
}

const servers: TestServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe("a real MCP service", () => {
  test("exposes its read-only tools under the service prefix and answers a call", async () => {
    const server = await startServer()
    servers.push(server)

    const mcp = await createLocalAIMcpTools(
      [
        {
          id: "notes",
          name: "Notes",
          transportType: "streamable-http",
          url: server.url,
          headers: { Authorization: "Bearer test-token" },
        },
      ],
      { log: () => {} },
    )

    try {
      expect(Object.keys(mcp.tools)).toEqual(["mcp__notes__search_notes"])

      await expect(run(mcp.tools, "mcp__notes__search_notes", { query: "unread" })).resolves.toBe(
        "notes about unread",
      )
      // The headers the renderer sent are the ones the service authenticated with.
      expect(server.seenAuthorization()).toBe("Bearer test-token")
    } finally {
      await mcp.close()
    }
  }, 20_000)

  test("skips a service that is not there", async () => {
    const logs: string[] = []

    const mcp = await createLocalAIMcpTools(
      [
        {
          id: "gone",
          name: "Gone",
          transportType: "streamable-http",
          // Nothing listens here; the request must fail fast instead of holding the chat.
          url: "http://127.0.0.1:1/mcp",
        },
      ],
      { log: (line) => logs.push(line) },
    )

    expect(mcp.tools).toEqual({})
    expect(logs.join("\n")).toContain("Gone unavailable")
    await mcp.close()
  }, 20_000)
})
