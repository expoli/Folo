/**
 * The real transport path: a Streamable HTTP MCP server on loopback, reached through the same
 * client, headers and approval rules the app uses. The unit tests substitute the connection; this
 * one proves the substitution is faithful against a server that speaks the protocol.
 */
import type { ToolSet } from "ai"
import { afterEach, describe, expect, test } from "vitest"

import { createLocalAIMcpTools } from "./mcp"
import type { TestMcpServer } from "./test-mcp-server"
import { startTestMcpServer } from "./test-mcp-server"

const run = async (tools: ToolSet, name: string, input: unknown): Promise<unknown> => {
  const entry = tools[name] as unknown as {
    execute?: (input: unknown, options: unknown) => Promise<unknown>
  }
  if (!entry?.execute) throw new Error(`${name} has no execute function`)
  return await entry.execute(input, { toolCallId: "call-1", messages: [] })
}

const servers: TestMcpServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe("a real MCP service", () => {
  test("offers its tools, asks approval for the one that can write, and answers a call", async () => {
    const server = await startTestMcpServer()
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
      // Both tools are offered; only the one that did not claim read-only needs a decision.
      expect(Object.keys(mcp.tools).sort()).toEqual([
        "mcp__notes__create_note",
        "mcp__notes__search_notes",
      ])
      expect(Object.keys(mcp.approvals)).toEqual(["mcp__notes__create_note"])

      await expect(run(mcp.tools, "mcp__notes__search_notes", { query: "unread" })).resolves.toBe(
        "notes about unread",
      )
      // The headers the renderer sent are the ones the service authenticated with.
      expect(server.authorization()).toBe("Bearer test-token")
      expect(server.calls).toEqual([{ name: "search_notes", args: { query: "unread" } }])
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
