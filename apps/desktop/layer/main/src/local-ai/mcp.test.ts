import type { LocalAIMcpService } from "@follow/shared/local-ai-mcp"
import { LOCAL_AI_MCP_LIMITS } from "@follow/shared/local-ai-mcp"
import type { ToolSet } from "ai"
import { describe, expect, test, vi } from "vitest"

import type { McpConnection, McpToolInfo } from "./mcp"
import { createLocalAIMcpTools } from "./mcp"

const service = (overrides: Partial<LocalAIMcpService> = {}): LocalAIMcpService => ({
  id: "svc-1",
  name: "Test Service",
  transportType: "streamable-http",
  url: "https://mcp.example.com/mcp",
  ...overrides,
})

const readOnly = (name: string, description = `About ${name}`): McpToolInfo => ({
  name,
  description,
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  annotations: { readOnlyHint: true },
})

const writable = (name: string): McpToolInfo => ({
  name,
  description: `Writes ${name}`,
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: false },
})

interface FakeOptions {
  tools?: McpToolInfo[]
  result?: unknown
  onCall?: (name: string, args: unknown) => void
  failList?: boolean
}

/** A connection that answers from the script instead of the network. */
const fakeConnection = (options: FakeOptions = {}) => {
  const calls: { name: string; args: unknown }[] = []
  let closed = 0

  const connection: McpConnection = {
    async listTools() {
      if (options.failList) throw new Error("handshake refused")
      return { tools: options.tools ?? [] }
    },
    async callTool(params) {
      calls.push({ name: params.name, args: params.arguments })
      options.onCall?.(params.name, params.arguments)
      return (
        (options.result as never) ?? {
          content: [{ type: "text", text: `answered ${params.name}` }],
        }
      )
    },
    async close() {
      closed += 1
    },
  }

  return { connection, calls, closed: () => closed }
}

/** `ToolSet` erases `execute`; the test calls it through this narrow view. */
const run = async (tools: ToolSet, name: string, input: unknown): Promise<unknown> => {
  const entry = tools[name] as unknown as {
    execute?: (input: unknown, options: unknown) => Promise<unknown>
  }
  if (!entry?.execute) throw new Error(`${name} has no execute function`)
  return await entry.execute(input, { toolCallId: "call-1", messages: [] })
}

const textResult = (text: string) => ({ content: [{ type: "text", text }] })

describe("createLocalAIMcpTools", () => {
  test("opens nothing when the request carries no services", async () => {
    const connect = vi.fn()

    const result = await createLocalAIMcpTools(undefined, { connect })

    expect(result.tools).toEqual({})
    expect(result.approvals).toEqual({})
    expect(connect).not.toHaveBeenCalled()
    await result.close()
  })

  test("drops a malformed service instead of failing the chat", async () => {
    const { connection } = fakeConnection({ tools: [readOnly("search")] })
    const connect = vi.fn(async () => connection)

    const result = await createLocalAIMcpTools(
      [service({ url: "file:///etc/passwd" }), service({ id: "svc-2" })],
      { connect },
    )

    expect(connect).toHaveBeenCalledTimes(1)
    expect(Object.keys(result.tools)).toEqual(["mcp__test_service__search"])
    await result.close()
  })

  test("asks for approval only on the tools that did not claim to be read-only", async () => {
    const { connection } = fakeConnection({
      tools: [readOnly("search"), writable("create_note"), { name: "unannotated" }],
    })

    const result = await createLocalAIMcpTools([service()], { connect: async () => connection })

    expect(Object.keys(result.tools).sort()).toEqual([
      "mcp__test_service__create_note",
      "mcp__test_service__search",
      "mcp__test_service__unannotated",
    ])
    // A server that annotates nothing gets the cautious reading, not the optimistic one.
    expect(result.approvals).toEqual({
      mcp__test_service__create_note: "user-approval",
      mcp__test_service__unannotated: "user-approval",
    })
    await result.close()
  })

  test("prefixes names with the service and keeps them unique", async () => {
    const { connection } = fakeConnection({ tools: [readOnly("search"), readOnly("search")] })
    const other = fakeConnection({ tools: [readOnly("search")] })

    const result = await createLocalAIMcpTools(
      [service(), service({ id: "svc-2", name: "Test Service" })],
      {
        connect: async (requested) => (requested.id === "svc-1" ? connection : other.connection),
      },
    )

    expect(Object.keys(result.tools)).toEqual([
      "mcp__test_service__search",
      "mcp__test_service__search_2",
      "mcp__test_service__search_3",
    ])
    await result.close()
  })

  test("tags the description with the service it came from", async () => {
    const { connection } = fakeConnection({ tools: [readOnly("search", "Looks things up")] })

    const result = await createLocalAIMcpTools([service()], { connect: async () => connection })

    expect(result.tools.mcp__test_service__search?.description).toBe(
      "Looks things up (from Test Service)",
    )
    await result.close()
  })

  test("stops offering tools at the limit", async () => {
    const many = Array.from({ length: LOCAL_AI_MCP_LIMITS.maxTools + 4 }, (_, index) =>
      readOnly(`tool_${index}`),
    )
    const { connection } = fakeConnection({ tools: many })
    const log = vi.fn()

    const result = await createLocalAIMcpTools([service()], {
      connect: async () => connection,
      log,
    })

    expect(Object.keys(result.tools)).toHaveLength(LOCAL_AI_MCP_LIMITS.maxTools)
    expect(log).toHaveBeenCalledWith(expect.stringContaining("left out"))
    await result.close()
  })

  test("passes the call through and returns the text", async () => {
    const { connection, calls } = fakeConnection({ tools: [readOnly("search")] })

    const result = await createLocalAIMcpTools([service()], { connect: async () => connection })
    const output = await run(result.tools, "mcp__test_service__search", { query: "unread" })

    expect(calls).toEqual([{ name: "search", args: { query: "unread" } }])
    expect(output).toBe("answered search")
    await result.close()
  })

  test("hands a server-reported error back to the model", async () => {
    const { connection } = fakeConnection({
      tools: [readOnly("search")],
      result: { isError: true, content: [{ type: "text", text: "rate limited" }] },
    })

    const result = await createLocalAIMcpTools([service()], { connect: async () => connection })

    await expect(run(result.tools, "mcp__test_service__search", {})).resolves.toEqual({
      error: "rate limited",
    })
    await result.close()
  })

  test("truncates an answer a server let run long", async () => {
    const { connection } = fakeConnection({
      tools: [readOnly("search")],
      result: textResult("x".repeat(LOCAL_AI_MCP_LIMITS.resultChars + 100)),
    })

    const result = await createLocalAIMcpTools([service()], { connect: async () => connection })
    const output = await run(result.tools, "mcp__test_service__search", {})

    expect(typeof output).toBe("string")
    expect(output as string).toHaveLength(
      LOCAL_AI_MCP_LIMITS.resultChars + "\n…[truncated 100 chars]".length,
    )
    expect(output).toContain("truncated 100 chars")
    await result.close()
  })

  test("renders a resource answer as its text and a byte answer as a marker", async () => {
    const { connection } = fakeConnection({
      tools: [readOnly("search")],
      result: {
        content: [
          { type: "resource", resource: { uri: "file://a", text: "from the file" } },
          { type: "resource", resource: { uri: "file://b", blob: "AAAA" } },
        ],
      },
    })

    const result = await createLocalAIMcpTools([service()], { connect: async () => connection })

    await expect(run(result.tools, "mcp__test_service__search", {})).resolves.toBe(
      "from the file\n[resource]",
    )
    await result.close()
  })

  test("skips a service it cannot reach and keeps the others", async () => {
    const working = fakeConnection({ tools: [readOnly("search")] })
    const log = vi.fn()

    const result = await createLocalAIMcpTools(
      [service({ id: "broken", name: "Broken" }), service()],
      {
        connect: async (requested) => {
          if (requested.id === "broken") throw new Error("connection refused")
          return working.connection
        },
        log,
      },
    )

    expect(Object.keys(result.tools)).toEqual(["mcp__test_service__search"])
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Broken unavailable"))
    await result.close()
  })

  test("closes the connection of a service that failed after connecting", async () => {
    const { connection, closed } = fakeConnection({ failList: true })

    const result = await createLocalAIMcpTools([service()], { connect: async () => connection })

    expect(closed()).toBe(1)
    await result.close()
  })

  test("closes every connection once", async () => {
    const first = fakeConnection({ tools: [] })
    const second = fakeConnection({ tools: [] })

    const result = await createLocalAIMcpTools([service(), service({ id: "svc-2" })], {
      connect: async (requested) =>
        requested.id === "svc-1" ? first.connection : second.connection,
    })

    await result.close()
    await result.close()

    expect(first.closed()).toBe(1)
    expect(second.closed()).toBe(1)
  })
})
