import { LOCAL_AI_DIGEST_TOOL_NAME } from "@follow/shared/local-agent-reading"
import type { LocalAIDirectConfig } from "@follow/shared/settings/local-ai"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { LocalAgentReadingToolHandlers } from "~/local-agent-reading/server"

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/folo-local-ai-chat-test" },
  // Direct-mode requests leave through Chromium's `net.fetch`; the cases below stub
  // `globalThis.fetch`, so this forwards to it (the same shim `routes.test.ts` uses).
  net: { fetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init) },
}))

const { createChatStreamResponse } = await import("./chat")
const { startTestMcpServer } = await import("./test-mcp-server")
const { resetToolSupport, setReadingToolHandlers } = await import("./tools")

const mcpServers: Awaited<ReturnType<typeof startTestMcpServer>>[] = []

const config: LocalAIDirectConfig = {
  baseUrl: "https://api.example.com/v1",
  model: "model-a",
  models: ["model-a"],
}

const encoder = new TextEncoder()

/** One OpenAI-compatible streaming response, delivered as the bytes the SDK expects. */
const sseResponse = (chunks: unknown[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  )

const textChunk = (content: string) => ({
  id: "chatcmpl-1",
  object: "chat.completion.chunk",
  created: 1,
  model: "model-a",
  choices: [{ index: 0, delta: { content }, finish_reason: null }],
})

const toolCallChunk = (name: string, args: string) => ({
  id: "chatcmpl-1",
  object: "chat.completion.chunk",
  created: 1,
  model: "model-a",
  choices: [
    {
      index: 0,
      delta: {
        tool_calls: [
          { index: 0, id: "call-1", type: "function", function: { name, arguments: args } },
        ],
      },
      finish_reason: null,
    },
  ],
})

const finishChunk = (reason: "tool_calls" | "stop") => ({
  id: "chatcmpl-1",
  object: "chat.completion.chunk",
  created: 1,
  model: "model-a",
  choices: [{ index: 0, delta: {}, finish_reason: reason }],
})

interface StubbedCall {
  body: Record<string, unknown> | null
}

/** Kept before any stub is installed, so a test can still reach a loopback MCP server. */
const realFetch = globalThis.fetch

/** Answers model calls in order, recording each request body; loopback traffic passes through. */
const stubUpstream = (responses: Response[]) => {
  const calls: StubbedCall[] = []
  let index = 0

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith("http://127.0.0.1")) return await realFetch(input, init)

    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null
    calls.push({ body })
    const response = responses[Math.min(index, responses.length - 1)]
    index += 1
    return response
  })

  return calls
}

const handlers = (overrides: Partial<LocalAgentReadingToolHandlers> = {}) => {
  const beginScan = vi.fn(async () => ({
    ok: true as const,
    data: { scanId: "scan-1", candidates: 1, selectedCount: 0, sources: [] },
  }))
  const value: LocalAgentReadingToolHandlers = {
    status: async () => ({ signedIn: true }) as never,
    beginScan: beginScan as never,
    listEntries: async () => ({ ok: true, data: { entries: [], hasMore: false } }) as never,
    getContents: async () => ({ ok: true, data: { items: [] } }) as never,
    ...overrides,
  }

  return { value, beginScan }
}

const send = async (
  options: {
    scene?: string
    mcpServices?: unknown
    messages?: unknown
    localAIContext?: unknown
  } = {},
) => {
  const response = await createChatStreamResponse({
    body: {
      messages: options.messages ?? [
        {
          id: "message-1",
          role: "user",
          parts: [{ type: "text", text: "看看这个订阅源还有什么没读" }],
        },
      ],
      scene: options.scene ?? "general",
      ...(options.mcpServices ? { mcpServices: options.mcpServices } : {}),
      ...(options.localAIContext ? { localAIContext: options.localAIContext } : {}),
    },
    config,
    apiKey: "test-key",
  })

  return await response.text()
}

beforeEach(() => {
  resetToolSupport()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setReadingToolHandlers(null)
  await Promise.all(mcpServers.splice(0).map((server) => server.close()))
})

describe("a chat with tools", () => {
  test("runs the tool the model asks for and answers from its result", async () => {
    const { value, beginScan } = handlers()
    setReadingToolHandlers(value)
    const calls = stubUpstream([
      sseResponse([
        toolCallChunk("folo_begin_unread_scan", '{"scope":{"feedIds":["feed-1"]}}'),
        finishChunk("tool_calls"),
      ]),
      sseResponse([textChunk("这个源还有 1 条未读。"), finishChunk("stop")]),
    ])

    const text = await send()

    expect(beginScan).toHaveBeenCalledWith({ scope: { feedIds: ["feed-1"] } })
    expect(calls).toHaveLength(2)
    // The second request carries the tool result, or the model would answer as if it never ran.
    expect(JSON.stringify(calls[1]?.body)).toContain("scan-1")
    expect(text).toContain("folo_begin_unread_scan")
    expect(text).toContain("这个源还有 1 条未读。")
  })

  test("scopes an unscoped scan to the feed the panel is showing", async () => {
    const { value, beginScan } = handlers()
    setReadingToolHandlers(value)
    stubUpstream([
      // The model omits `scope`, which the reading contract reads as the whole account.
      sseResponse([toolCallChunk("folo_begin_unread_scan", "{}"), finishChunk("tool_calls")]),
      sseResponse([textChunk("这个源还有 1 条未读。"), finishChunk("stop")]),
    ])

    await send({
      localAIContext: {
        blocks: [
          { type: "mainFeed", value: "feed-1" },
          { type: "unreadOnly", value: "true" },
        ],
      },
    })

    expect(beginScan).toHaveBeenCalledWith({ scope: { feedIds: ["feed-1"] } })
  })

  test("scopes an unscoped scan to the period the prompt named", async () => {
    const { value, beginScan } = handlers()
    setReadingToolHandlers(value)
    stubUpstream([
      sseResponse([toolCallChunk("folo_begin_unread_scan", "{}"), finishChunk("tool_calls")]),
      sseResponse([textChunk("今天没有未读。"), finishChunk("stop")]),
    ])

    await send({
      localAIContext: {
        blocks: [],
        coverage: {
          matched: 0,
          publishedAfter: "2026-10-30T00:00:00.000Z",
          publishedBefore: "2026-10-30T23:59:59.999Z",
        },
      },
    })

    expect(beginScan).toHaveBeenCalledWith({
      scope: {
        publishedAfter: "2026-10-30T00:00:00.000Z",
        publishedBefore: "2026-10-30T23:59:59.999Z",
      },
    })
  })

  test("scopes the digest to the panel's feed and keeps the window it asked for", async () => {
    const { value, beginScan } = handlers()
    setReadingToolHandlers(value)
    const calls = stubUpstream([
      sseResponse([
        toolCallChunk(LOCAL_AI_DIGEST_TOOL_NAME, '{"window":"today"}'),
        finishChunk("tool_calls"),
      ]),
      sseResponse([textChunk("今天这个源没有未读。"), finishChunk("stop")]),
    ])

    const text = await send({
      localAIContext: {
        blocks: [{ type: "mainFeed", value: "feed-1" }],
      },
    })

    expect(beginScan).toHaveBeenCalledWith({
      scope: expect.objectContaining({ feedIds: ["feed-1"] }),
    })
    expect(calls).toHaveLength(2)
    expect(text).toContain("今天这个源没有未读。")
    expect(text).not.toContain('"type":"error"')
  })

  test("offers no tools to a timeline summary, which already reads its articles", async () => {
    const { value, beginScan } = handlers()
    setReadingToolHandlers(value)
    const calls = stubUpstream([sseResponse([textChunk("摘要"), finishChunk("stop")])])

    await send({ scene: "timeline-summary" })

    expect(calls[0]?.body?.tools).toBeUndefined()
    expect(beginScan).not.toHaveBeenCalled()
  })

  test("offers no tools while no reading service is bound", async () => {
    const calls = stubUpstream([sseResponse([textChunk("好的"), finishChunk("stop")])])

    await send()

    expect(calls[0]?.body?.tools).toBeUndefined()
  })

  test("a tool that can write waits for the user instead of running", async () => {
    const { value } = handlers()
    setReadingToolHandlers(value)
    const server = await startTestMcpServer()
    mcpServers.push(server)

    const calls = stubUpstream([
      // The model reaches for a write tool on the MCP service.
      sseResponse([
        toolCallChunk("mcp__notes__create_note", '{"title":"Kconfig 备份","body":"副本"}'),
        finishChunk("tool_calls"),
      ]),
      sseResponse([textChunk("等你确认。"), finishChunk("stop")]),
    ])

    const text = await send({
      mcpServices: [
        { id: "notes", name: "Notes", transportType: "streamable-http", url: server.url },
      ],
    })

    // The loop stops at the decision and asks for it; the tool itself never ran.
    expect(text).toContain("tool-approval-request")
    expect(text).not.toContain("tool-output-available")
    expect(server.calls).toEqual([])
    // The model was asked once and the request stopped there: nothing runs while the user decides.
    expect(calls).toHaveLength(1)
  })

  test("the approved tool runs when the decision comes back", async () => {
    const { value } = handlers()
    setReadingToolHandlers(value)
    const server = await startTestMcpServer()
    mcpServers.push(server)

    stubUpstream([sseResponse([textChunk("已写入。"), finishChunk("stop")])])

    // What the panel sends after the user clicks Allow: the same conversation, now carrying the
    // tool call with its decision.
    const text = await send({
      mcpServices: [
        { id: "notes", name: "Notes", transportType: "streamable-http", url: server.url },
      ],
      messages: [
        { id: "m1", role: "user", parts: [{ type: "text", text: "把这条笔记复制一份" }] },
        {
          id: "m2",
          role: "assistant",
          parts: [
            {
              type: "tool-mcp__notes__create_note",
              toolCallId: "call-1",
              state: "approval-responded",
              input: { title: "Kconfig 备份", body: "副本" },
              approval: { id: "approval-1", approved: true },
            },
          ],
        },
      ],
    })

    expect(server.calls).toEqual([
      { name: "create_note", args: { title: "Kconfig 备份", body: "副本" } },
    ])
    expect(text).toContain("已写入。")
  })

  test("retries a tool rejection in the same request and remembers the unsupported endpoint", async () => {
    const { value } = handlers()
    setReadingToolHandlers(value)
    const calls = stubUpstream([
      new Response(JSON.stringify({ error: { message: "this model does not support tools" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
      sseResponse([textChunk("当前请求已降级。"), finishChunk("stop")]),
      sseResponse([textChunk("后续请求不再尝试工具。"), finishChunk("stop")]),
    ])

    const first = await send()
    const second = await send()

    expect(calls).toHaveLength(3)
    expect(calls[0]?.body?.tools).toBeDefined()
    expect(calls[1]?.body?.tools).toBeUndefined()
    expect(calls[2]?.body?.tools).toBeUndefined()
    expect(JSON.stringify(calls[1]?.body)).not.toContain("folo_begin_unread_scan")
    expect(first).toContain("当前请求已降级。")
    expect(first).not.toContain('"type":"error"')
    expect(first.match(/"type":"start"/g)).toHaveLength(1)
    expect(first.match(/"type":"finish"/g)).toHaveLength(1)
    expect(second).toContain("后续请求不再尝试工具。")
  })

  test("does not retry a rejection after a tool has already executed", async () => {
    const { value, beginScan } = handlers()
    setReadingToolHandlers(value)
    const calls = stubUpstream([
      sseResponse([toolCallChunk("folo_begin_unread_scan", "{}"), finishChunk("tool_calls")]),
      new Response(JSON.stringify({ error: { message: "tools are not supported" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    ])

    const text = await send()

    expect(beginScan).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(2)
    expect(text).toContain('"type":"error"')
  })

  test("keeps unrelated endpoint errors visible without disabling or retrying tools", async () => {
    const { value } = handlers()
    setReadingToolHandlers(value)
    const calls = stubUpstream([
      new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
      sseResponse([textChunk("修正凭据后的回答。"), finishChunk("stop")]),
    ])

    const first = await send()
    const second = await send()

    expect(first).toContain('"type":"error"')
    expect(calls).toHaveLength(2)
    expect(calls[1]?.body?.tools).toBeDefined()
    expect(second).toContain("修正凭据后的回答。")
  })
})
