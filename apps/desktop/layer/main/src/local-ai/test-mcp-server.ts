/**
 * A real MCP service for the tests that need one: two tools, one of which claims to be read-only.
 *
 * It records every call it receives, so a test can assert that a tool which needed approval never
 * ran, and one that did not need it did.
 */
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod"

export interface TestMcpServer {
  url: string
  /** Tool calls the server actually received, in order. */
  calls: { name: string; args: unknown }[]
  /** `Authorization` of the last request, to check that headers travel. */
  authorization: () => string | null
  close: () => Promise<void>
}

export const startTestMcpServer = async (): Promise<TestMcpServer> => {
  const calls: TestMcpServer["calls"] = []
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
        async (args) => {
          calls.push({ name: "search_notes", args })
          return { content: [{ type: "text" as const, text: `notes about ${args.query}` }] }
        },
      )
      server.registerTool(
        "create_note",
        {
          title: "Create note",
          description: "Writes a note",
          inputSchema: { title: z.string(), body: z.string() },
          annotations: { readOnlyHint: false },
        },
        async (args) => {
          calls.push({ name: "create_note", args })
          return { content: [{ type: "text" as const, text: `created ${args.title}` }] }
        },
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
    calls,
    authorization: () => authorization,
    close: () =>
      new Promise<void>((resolve) => {
        http.close(() => resolve())
      }),
  }
}
