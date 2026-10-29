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
const { resetToolSupport, setReadingToolHandlers } = await import("./tools")

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

/** Answers upstream calls in order, recording each request body. */
const stubUpstream = (responses: Response[]) => {
  const calls: StubbedCall[] = []
  let index = 0

  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
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
    data: { scanId: "scan-1", candidates: 1 },
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

const send = async (scene = "general") => {
  const response = await createChatStreamResponse({
    body: {
      messages: [
        {
          id: "message-1",
          role: "user",
          parts: [{ type: "text", text: "看看这个订阅源还有什么没读" }],
        },
      ],
      scene,
    },
    config,
    apiKey: "test-key",
  })

  return await response.text()
}

beforeEach(() => {
  resetToolSupport()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setReadingToolHandlers(null)
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

  test("offers no tools to a timeline summary, which already reads its articles", async () => {
    const { value, beginScan } = handlers()
    setReadingToolHandlers(value)
    const calls = stubUpstream([sseResponse([textChunk("摘要"), finishChunk("stop")])])

    await send("timeline-summary")

    expect(calls[0]?.body?.tools).toBeUndefined()
    expect(beginScan).not.toHaveBeenCalled()
  })

  test("offers no tools while no reading service is bound", async () => {
    const calls = stubUpstream([sseResponse([textChunk("好的"), finishChunk("stop")])])

    await send()

    expect(calls[0]?.body?.tools).toBeUndefined()
  })

  test("stops sending tools once the endpoint says it has none", async () => {
    const { value } = handlers()
    setReadingToolHandlers(value)
    const calls = stubUpstream([
      new Response(JSON.stringify({ error: { message: "this model does not support tools" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
      sseResponse([textChunk("好的"), finishChunk("stop")]),
    ])

    // The first chat fails the way the endpoint does; the second one is sent without tools.
    await send()
    await send()

    expect(calls[0]?.body?.tools).toBeDefined()
    expect(calls[1]?.body?.tools).toBeUndefined()
  })
})
