import type { LocalAIDirectConfig } from "@follow/shared/settings/local-ai"
import {
  LOCAL_AI_CHAT_STREAM_CHANNEL,
  LOCAL_AI_DIRECT_ORIGIN,
} from "@follow/shared/settings/local-ai"
import { probeLocalAIGateway } from "@follow/store/ai-local/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  openChatStream: vi.fn(),
  closeChatStream: vi.fn(),
}))

vi.mock("~/lib/client", () => ({
  ipcServices: {
    localAI: {
      request: mocks.request,
      openChatStream: mocks.openChatStream,
      closeChatStream: mocks.closeChatStream,
    },
  },
}))

const { createLocalAIDirectFetch } = await import("./local-ai-direct-fetch")

const config: LocalAIDirectConfig = {
  baseUrl: "https://api.example.com/v1",
  model: "model-a",
  models: ["model-a"],
}

/** Captures the listener the direct fetch registers for streamed chat answers. */
const streamListeners = new Map<string, (event: unknown, payload: unknown) => void>()

const pushStreamEvent = (payload: unknown) => {
  for (const listener of streamListeners.values()) listener({}, payload)
}

beforeEach(() => {
  mocks.request.mockReset()
  mocks.openChatStream.mockReset()
  mocks.closeChatStream.mockReset()
  streamListeners.clear()

  Object.defineProperty(window, "electron", {
    configurable: true,
    value: {
      ipcRenderer: {
        on: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
          streamListeners.set(channel, listener)
          return () => streamListeners.delete(channel)
        },
      },
    },
  })
})

afterEach(() => {
  Reflect.deleteProperty(window, "electron")
})

const directFetch = (getConfig: () => LocalAIDirectConfig | null = () => config) =>
  createLocalAIDirectFetch(getConfig)

describe("createLocalAIDirectFetch", () => {
  test("maps a request path onto the IPC request and rebuilds the response", async () => {
    mocks.request.mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: 0, data: "summary" }),
    })

    const response = await directFetch()(`${LOCAL_AI_DIRECT_ORIGIN}/ai/summary`, {
      method: "POST",
      body: JSON.stringify({ content: "Body" }),
    })

    expect(mocks.request).toHaveBeenCalledWith({
      path: "/ai/summary",
      method: "POST",
      body: JSON.stringify({ content: "Body" }),
      config,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/json")
    await expect(response.json()).resolves.toEqual({ code: 0, data: "summary" })
  })

  test("keeps the query string of health checks", async () => {
    mocks.request.mockResolvedValue({ status: 200, headers: {}, body: "{}" })

    await directFetch()(`${LOCAL_AI_DIRECT_ORIGIN}/health?probe=1`)

    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/health?probe=1", method: "GET", body: null }),
    )
  })

  test("builds a bodyless response for a 204, which chat resumption answers", async () => {
    mocks.request.mockResolvedValue({ status: 204, headers: {}, body: "" })

    const response = await directFetch()(`${LOCAL_AI_DIRECT_ORIGIN}/ai/chat/chat-1/stream`, {
      method: "GET",
    })

    expect(response.status).toBe(204)
    expect(await response.text()).toBe("")
  })

  test("refuses to guess when the user has not configured an endpoint", async () => {
    await expect(directFetch(() => null)(`${LOCAL_AI_DIRECT_ORIGIN}/ai/summary`)).rejects.toThrow(
      /No direct AI endpoint is configured/,
    )
    expect(mocks.request).not.toHaveBeenCalled()
  })

  test("streams a chat answer as a readable body", async () => {
    mocks.openChatStream.mockResolvedValue({
      streamId: "stream-1",
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: null,
    })

    const response = await directFetch()(`${LOCAL_AI_DIRECT_ORIGIN}/ai/chat`, {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    })

    expect(mocks.openChatStream).toHaveBeenCalledWith({
      body: JSON.stringify({ messages: [] }),
      config,
    })
    expect(response.status).toBe(200)

    const reader = response.body!.getReader()
    pushStreamEvent({ streamId: "stream-1", chunk: "data: one\n\n" })

    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe("data: one\n\n")

    pushStreamEvent({ streamId: "stream-1", done: true })
    await expect(reader.read()).resolves.toMatchObject({ done: true })
  })

  test("keeps a chunk that arrives before the stream is opened", async () => {
    // The main process starts pushing as soon as it answers, while the renderer only learns the
    // stream id from that answer: a chunk that wins the race must not be dropped (and a chunk of
    // another stream must not leak in).
    mocks.openChatStream.mockImplementation(async () => {
      pushStreamEvent({ streamId: "stream-early", chunk: "early " })
      pushStreamEvent({ streamId: "stream-other", chunk: "not mine" })
      pushStreamEvent({ streamId: "stream-early", done: true })

      return {
        streamId: "stream-early",
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: null,
      }
    })

    const response = await directFetch()(`${LOCAL_AI_DIRECT_ORIGIN}/ai/chat`, {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    })
    const text = await response.text()

    expect(text).toBe("early ")
  })

  test("ignores stream events of another chat", async () => {
    mocks.openChatStream.mockResolvedValue({
      streamId: "stream-1",
      status: 200,
      headers: {},
      body: null,
    })

    const response = await directFetch()(`${LOCAL_AI_DIRECT_ORIGIN}/ai/chat`, { method: "POST" })
    const reader = response.body!.getReader()

    pushStreamEvent({ streamId: "other-stream", chunk: "nope" })
    pushStreamEvent({ streamId: "stream-1", chunk: "data: one\n\n" })

    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe("data: one\n\n")

    pushStreamEvent({ streamId: "stream-1", done: true })
    await reader.cancel()
  })

  test("fails the response when the upstream stream breaks", async () => {
    mocks.openChatStream.mockResolvedValue({
      streamId: "stream-1",
      status: 200,
      headers: {},
      body: null,
    })

    const response = await directFetch()(`${LOCAL_AI_DIRECT_ORIGIN}/ai/chat`, { method: "POST" })
    const reader = response.body!.getReader()

    pushStreamEvent({ streamId: "stream-1", error: "socket closed" })

    await expect(reader.read()).rejects.toThrow("socket closed")
  })

  test("stops the upstream model call when the renderer aborts", async () => {
    mocks.openChatStream.mockResolvedValue({
      streamId: "stream-1",
      status: 200,
      headers: {},
      body: null,
    })
    mocks.closeChatStream.mockResolvedValue(true)

    const controller = new AbortController()
    const response = await directFetch()(`${LOCAL_AI_DIRECT_ORIGIN}/ai/chat`, {
      method: "POST",
      signal: controller.signal,
    })
    const reader = response.body!.getReader()

    controller.abort()

    await expect(reader.read()).rejects.toThrow(/aborted/)
    expect(streamListeners.size).toBe(0)
    await vi.waitFor(() => {
      expect(mocks.closeChatStream).toHaveBeenCalledWith({ streamId: "stream-1" })
    })
  })

  test("answers a rejected chat request in one piece", async () => {
    mocks.openChatStream.mockResolvedValue({
      streamId: null,
      status: 400,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "No message text found in the request" }),
    })

    const response = await directFetch()(`${LOCAL_AI_DIRECT_ORIGIN}/ai/chat`, { method: "POST" })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: "No message text found in the request",
    })
  })
})

describe("probing a direct endpoint before it is saved", () => {
  test("reports a healthy endpoint with the model latency", async () => {
    mocks.request.mockImplementation(async ({ path }: { path: string }) =>
      path === "/ai/chat/config"
        ? {
            status: 200,
            headers: {},
            body: JSON.stringify({ defaultModel: "model-a", availableModels: ["model-a"] }),
          }
        : {
            status: 200,
            headers: {},
            body: JSON.stringify({
              ok: true,
              upstream: "https://api.example.com/v1",
              defaultModel: "model-a",
              probe: { ok: true, latencyMs: 12 },
            }),
          },
    )

    await expect(
      probeLocalAIGateway({ baseUrl: LOCAL_AI_DIRECT_ORIGIN, fetch: directFetch() }),
    ).resolves.toEqual({
      kind: "ok",
      latencyMs: 12,
      upstream: "https://api.example.com/v1",
      defaultModel: "model-a",
    })
  })

  test("reports a rejected API key", async () => {
    mocks.request.mockResolvedValue({ status: 401, headers: {}, body: "Unauthorized" })

    await expect(
      probeLocalAIGateway({ baseUrl: LOCAL_AI_DIRECT_ORIGIN, fetch: directFetch() }),
    ).resolves.toEqual({ kind: "token-rejected" })
  })

  test("reports an unreachable endpoint with the transport failure", async () => {
    mocks.request.mockRejectedValue(new Error("connect ECONNREFUSED"))

    const result = await probeLocalAIGateway({
      baseUrl: LOCAL_AI_DIRECT_ORIGIN,
      fetch: directFetch(),
    })

    expect(result.kind).toBe("unreachable")
    expect((result as { detail: string }).detail).toContain("ECONNREFUSED")
  })

  test("reports a model that failed the probe", async () => {
    mocks.request
      .mockResolvedValueOnce({ status: 200, headers: {}, body: "{}" })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ ok: true, probe: { ok: false, error: "model refused the ping" } }),
      })

    await expect(
      probeLocalAIGateway({ baseUrl: LOCAL_AI_DIRECT_ORIGIN, fetch: directFetch() }),
    ).resolves.toEqual({ kind: "upstream-error", detail: "model refused the ping" })
  })

  test("probes the draft endpoint the settings page is showing", async () => {
    mocks.request.mockResolvedValue({ status: 200, headers: {}, body: "{}" })
    const draft: LocalAIDirectConfig = {
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "draft-model",
      models: [],
    }

    await probeLocalAIGateway({
      baseUrl: LOCAL_AI_DIRECT_ORIGIN,
      fetch: directFetch(() => draft),
    })

    expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ config: draft }))
  })
})

describe("stream channel", () => {
  test("is the channel the main process pushes on", () => {
    expect(LOCAL_AI_CHAT_STREAM_CHANNEL).toBe("localAI.chatStream")
  })
})
