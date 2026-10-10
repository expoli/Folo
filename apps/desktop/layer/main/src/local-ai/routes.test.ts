import type { LocalAIDirectConfig } from "@follow/shared/settings/local-ai"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { DIRECT_CONTEXT_BUDGET } from "./provider"
import {
  handleConfig,
  handleHealth,
  parseModelIds,
  resetModelListCache,
  routeLocalAIRequest,
} from "./routes"

// Direct-mode requests go through Chromium's `net.fetch`; the cases below stub `globalThis.fetch`,
// so this forwards to it.
vi.mock("electron", () => ({
  net: { fetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init) },
}))

const config: LocalAIDirectConfig = {
  baseUrl: "https://api.example.com/v1",
  model: "model-a",
  models: ["model-a", "model-b"],
}

interface StubbedCall {
  url: string
  method: string
  authorization?: string
  body: Record<string, unknown> | null
}

/** Answers every upstream request with `handler` and records what was requested. */
const readHeaders = (headers: HeadersInit | undefined) => {
  if (!headers) return {} as Record<string, string>
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers)

  return headers as Record<string, string>
}

const stubUpstream = (handler: (call: StubbedCall) => Response | Promise<Response>) => {
  const calls: StubbedCall[] = []

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const headers = readHeaders(init?.headers)
    const call: StubbedCall = {
      url,
      method: init?.method ?? "GET",
      authorization: Object.entries(headers).find(
        ([name]) => name.toLowerCase() === "authorization",
      )?.[1],
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    }
    calls.push(call)

    return handler(call)
  })

  return calls
}

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  })

const completion = (text: string) =>
  json({
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "model-a",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })

const sseStream = (text: string) => {
  const chunks = [
    `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "model-a", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "model-a", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
    "data: [DONE]\n\n",
  ]

  return new Response(chunks.join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

beforeEach(() => {
  // The model list is cached between requests; cases have to start from a clean slate.
  resetModelListCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("parseModelIds", () => {
  test("reads the OpenAI shape", () => {
    expect(parseModelIds({ object: "list", data: [{ id: "a" }, { id: "b" }] })).toEqual(["a", "b"])
  })

  test("tolerates plain string lists", () => {
    expect(parseModelIds(["a", "b"])).toEqual(["a", "b"])
    expect(parseModelIds({ data: ["a", " "] })).toEqual(["a"])
  })

  test("ignores entries without a usable id", () => {
    expect(parseModelIds({ data: [{ id: 3 }, {}, "a"] })).toEqual(["a"])
  })

  test("returns nothing for an unexpected payload", () => {
    expect(parseModelIds(null)).toEqual([])
    expect(parseModelIds("nope")).toEqual([])
    expect(parseModelIds({})).toEqual([])
  })
})

describe("handleConfig", () => {
  test("uses the endpoint's model list and reports the context budget", async () => {
    const calls = stubUpstream(() => json({ data: [{ id: "upstream-a" }, { id: "upstream-b" }] }))

    const response = await handleConfig(config, "secret-key")
    const payload = (await response.json()) as Record<string, unknown>

    expect(calls[0]).toMatchObject({
      url: "https://api.example.com/v1/models",
      authorization: "Bearer secret-key",
    })
    expect(payload).toEqual({
      defaultModel: "model-a",
      availableModels: ["upstream-a", "upstream-b"],
      availableModelsMenu: [
        { label: "upstream-a", value: "upstream-a" },
        { label: "upstream-b", value: "upstream-b" },
      ],
      localAIContext: DIRECT_CONTEXT_BUDGET,
    })
  })

  test("falls back to the configured models when the endpoint has no /models route", async () => {
    stubUpstream(() => new Response("not found", { status: 404 }))

    const payload = (await (await handleConfig(config, null)).json()) as Record<string, unknown>

    expect(payload.availableModels).toEqual(["model-a", "model-b"])
  })

  test("falls back to the configured models when the endpoint is unreachable", async () => {
    stubUpstream(() => {
      throw new Error("connect ECONNREFUSED")
    })

    const payload = (await (await handleConfig(config, null)).json()) as Record<string, unknown>

    expect(payload.availableModels).toEqual(["model-a", "model-b"])
  })

  test("reports a rejected API key instead of hiding it behind the fallback", async () => {
    stubUpstream(() => new Response("Unauthorized", { status: 401 }))

    const response = await handleConfig(config, "wrong-key")

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("rejected"),
    })
  })

  test("sends no authorization header without a key, for keyless local endpoints", async () => {
    const calls = stubUpstream(() => json({ data: [{ id: "local" }] }))

    await handleConfig(config, null)

    expect(calls[0]!.authorization).toBeUndefined()
  })
})

describe("handleHealth", () => {
  test("answers without calling the model when no probe was asked for", async () => {
    const calls = stubUpstream(() => json({}))

    const payload = (await (await handleHealth(config, null, false)).json()) as Record<
      string,
      unknown
    >

    expect(payload).toEqual({
      ok: true,
      upstream: "https://api.example.com/v1",
      defaultModel: "model-a",
      models: ["model-a", "model-b"],
    })
    expect(calls).toHaveLength(0)
  })

  test("probes the model once and reports the latency", async () => {
    const calls = stubUpstream(() => completion("pong"))

    const payload = (await (await handleHealth(config, "secret-key", true)).json()) as {
      probe: { ok: boolean; latencyMs: number }
    }

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("https://api.example.com/v1/chat/completions")
    expect(calls[0]!.authorization).toBe("Bearer secret-key")
    expect(payload.probe.ok).toBe(true)
    expect(typeof payload.probe.latencyMs).toBe("number")
  })

  test("reports a failing model call as an upstream error with its message", async () => {
    stubUpstream(() => json({ error: { message: "model is busy" } }, 503))

    const payload = (await (await handleHealth(config, null, true)).json()) as {
      probe: { ok: boolean; error: string }
    }

    expect(payload.probe.ok).toBe(false)
    expect(payload.probe.error).toContain("model is busy")
  })

  test("reports a missing model instead of probing without one", async () => {
    stubUpstream(() => completion("unused"))

    const payload = (await (
      await handleHealth({ baseUrl: config.baseUrl, model: "", models: [] }, null, true)
    ).json()) as { defaultModel: string; probe: { ok: boolean; error: string } }

    expect(payload.defaultModel).toBe("")
    expect(payload.probe).toMatchObject({ ok: false })
    expect(payload.probe.error).toContain("No model is configured")
  })
})

describe("routeLocalAIRequest", () => {
  const route = (input: Partial<Parameters<typeof routeLocalAIRequest>[0]>) =>
    routeLocalAIRequest({
      path: "/ai/summary",
      method: "POST",
      body: null,
      config,
      apiKey: null,
      ...input,
    })

  test("answers 404 for a path outside the contract", async () => {
    const response = await route({ path: "/ai/unknown", method: "GET" })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({
      error: "Unsupported endpoint: GET /ai/unknown",
    })
  })

  test("answers 204 for a stream resume, since chat history stays on the client", async () => {
    const response = await route({ path: "/ai/chat/chat-1/stream", method: "GET", body: null })

    expect(response.status).toBe(204)
    expect(await response.text()).toBe("")
  })

  test("rejects a body that is not JSON", async () => {
    const response = await route({ body: "not json" })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("JSON") })
  })

  test("serves a summary end to end", async () => {
    const calls = stubUpstream(() => completion("Summarized"))

    const response = await route({ body: JSON.stringify({ content: "Body", language: "en" }) })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ code: 0, data: "Summarized" })
    expect(calls[0]!.body).toMatchObject({ model: "model-a" })
  })

  test("serves a chat title for the local model to write", async () => {
    stubUpstream(() => completion('  "A tidy title."  '))

    const response = await route({
      path: "/ai/summary-title",
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ title: "A tidy title" })
  })

  test("rejects a title request without messages", async () => {
    stubUpstream(() => completion("unused"))

    const response = await route({ path: "/ai/summary-title", body: JSON.stringify({}) })

    expect(response.status).toBe(400)
  })

  test("falls back to the conversation when the model returns no text", async () => {
    // A reasoning model can spend an entire budget thinking; the action should still do something.
    stubUpstream(() => completion(""))

    const response = await route({
      path: "/ai/summary-title",
      body: JSON.stringify({ messages: [{ role: "assistant", content: "A short answer" }] }),
    })

    await expect(response.json()).resolves.toEqual({ title: "A short answer" })
  })

  test("writes a title with the same budget as every other call", async () => {
    const calls = stubUpstream(() => completion("Tidy"))

    const response = await route({
      path: "/ai/summary-title",
      config: { ...config, maxOutputTokens: 1234 },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    })

    await response.json()

    expect(calls[0]!.body).toMatchObject({ max_tokens: 1234 })
  })

  test("serves a translation batch end to end", async () => {
    stubUpstream(() => completion(JSON.stringify({ title: "Titel" })))

    const response = await route({
      path: "/ai/translation/batch",
      body: JSON.stringify({
        entries: [{ id: "e1", title: "Title" }],
        fields: ["title"],
        language: "de",
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe(
      `${JSON.stringify({ id: "e1", data: { title: "Titel" } })}\n`,
    )
  })

  test("serves the chat as a UI message stream with the context in the system prompt", async () => {
    const calls = stubUpstream(() => sseStream("Hello there"))

    const response = await route({
      path: "/ai/chat",
      body: JSON.stringify({
        messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }],
        localAIContext: { entries: [{ title: "Entry", content: "Entry body" }] },
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.text()

    expect(body).toContain("Hello there")
    const system = (calls[0]!.body?.messages as { role: string; content: string }[]).find(
      (message) => message.role === "system",
    )
    expect(system?.content).toContain("Entry body")
  })

  test("applies the tuning of the direct endpoint", async () => {
    const calls = stubUpstream(() => sseStream("ok"))

    const response = await route({
      path: "/ai/chat",
      config: {
        ...config,
        maxOutputTokens: 1234,
        temperature: 0.25,
        reasoningEffort: "high",
        extraRequestBody: '{"thinking_budget":1024}',
      },
      body: JSON.stringify({
        messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }],
      }),
    })

    expect(response.status).toBe(200)
    await response.text()

    // The knobs of the settings reach the endpoint: the provider's own options, and the extra
    // JSON the user added for a knob the OpenAI-compatible schema does not know.
    expect(calls[0]!.body).toMatchObject({
      max_tokens: 1234,
      temperature: 0.25,
      reasoning_effort: "high",
      thinking_budget: 1024,
    })
  })

  test("tells the model which language to answer in", async () => {
    const calls = stubUpstream(() => sseStream("你好"))

    const response = await route({
      path: "/ai/chat",
      body: JSON.stringify({
        messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }],
        language: "zh-CN",
      }),
    })

    expect(response.status).toBe(200)
    await response.text()

    const system = (calls[0]!.body?.messages as { role: string; content: string }[]).find(
      (message) => message.role === "system",
    )
    // A shortcut's own prompt may be English; the answer still has to match the interface.
    expect(system?.content).toContain("Reply in Simplified Chinese.")
  })

  test("rejects a chat request without message text", async () => {
    stubUpstream(() => sseStream("unused"))

    const response = await route({ path: "/ai/chat", body: JSON.stringify({ messages: [] }) })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: "No message text found in the request",
    })
  })
})
