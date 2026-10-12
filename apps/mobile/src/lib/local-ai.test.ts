import type { LocalAIGatewaySettings } from "@follow/shared/settings/interface"
import type { LocalAIDirectConfig } from "@follow/shared/settings/local-ai"
import { LOCAL_AI_DIRECT_ORIGIN } from "@follow/shared/settings/local-ai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  settings: null as LocalAIGatewaySettings | null,
  apiKey: null as string | null,
  defaults: null as LocalAIGatewaySettings | null,
  toasts: [] as string[],
}))

vi.mock("@/src/lib/toast", () => ({
  toast: {
    error: (message: string) => mocks.toasts.push(message),
    success: vi.fn(),
    info: vi.fn(),
    show: vi.fn(),
  },
}))

vi.mock("@/src/lib/secure-store", () => ({
  safeSecureStore: {
    getItem: (key: string) => (key === "follow_local_ai_direct_api_key" ? mocks.apiKey : null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}))

vi.mock("@/src/atoms/settings/ai", () => ({
  createDefaultAISettings: () => ({ localGateway: mocks.defaults }),
  getAISettings: () => ({ localGateway: mocks.settings }),
  setSetting: vi.fn(),
}))

const defaultGatewaySettings = (): LocalAIGatewaySettings =>
  ({
    enabled: false,
    mode: "direct",
    baseUrl: "",
    token: "",
    directBaseUrl: "",
    directModel: "",
    directModels: [],
    directOptions: {
      maxOutputTokens: null,
      temperature: null,
      reasoningEffort: null,
      extraRequestBody: "",
      summaryChunkChars: null,
      translationChunkChars: null,
      translationConcurrency: null,
    },
  }) satisfies LocalAIGatewaySettings

const directConfig = (patch: Partial<LocalAIDirectConfig> = {}): LocalAIDirectConfig => ({
  baseUrl: "https://api.example.com/v1",
  model: "model-a",
  models: ["model-a"],
  ...patch,
})

/** One stubbed upstream answer, recording what the direct core sent to the endpoint. */
const stubEndpoint = (reply: unknown) => {
  const calls: { url: string; body: Record<string, unknown> | null; authorization?: string }[] = []

  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init?.headers as HeadersInit | undefined)
    calls.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      authorization: headers.get("authorization") ?? undefined,
    })

    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  })

  globalThis.fetch = fetch as unknown as typeof globalThis.fetch

  return calls
}

const loadModule = async () => import("./local-ai")

describe("mobile local AI", () => {
  beforeEach(() => {
    mocks.settings = defaultGatewaySettings()
    mocks.defaults = defaultGatewaySettings()
    mocks.apiKey = null
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("keeps the direct endpoint address out of the runtime while it is not filled in", async () => {
    const { applyLocalAISettings, getDirectConfig } = await loadModule()

    expect(getDirectConfig()).toBeNull()
    expect(applyLocalAISettings().baseUrl).toBeNull()
  })

  it("routes a summary through the shared direct core and buffers the answer", async () => {
    const calls = stubEndpoint({
      choices: [{ message: { content: "a short summary" } }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    })

    const { createLocalAIDirectFetch } = await loadModule()
    const fetch = createLocalAIDirectFetch(
      () => directConfig(),
      () => "secret-key",
    )

    const response = await fetch(`${LOCAL_AI_DIRECT_ORIGIN}/ai/summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entryId: "entry-1",
        language: "en",
        target: "content",
        title: "Title",
        content: "The article text.",
      }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ data: "a short summary" })
    expect(calls[0]?.url).toBe("https://api.example.com/v1/chat/completions")
    expect(calls[0]?.authorization).toBe("Bearer secret-key")
    expect(calls[0]?.body).toMatchObject({ model: "model-a" })
  })

  it("answers an unknown path with 404 instead of reaching the endpoint", async () => {
    const calls = stubEndpoint({})

    const { createLocalAIDirectFetch } = await loadModule()
    const fetch = createLocalAIDirectFetch(() => directConfig())

    const response = await fetch(`${LOCAL_AI_DIRECT_ORIGIN}/ai/unknown`, { method: "POST" })

    expect(response.status).toBe(404)
    expect(calls).toHaveLength(0)
  })

  it("refuses a request while no endpoint is configured", async () => {
    const calls = stubEndpoint({})
    mocks.settings = { ...defaultGatewaySettings(), enabled: true }

    const { applyLocalAISettings, createLocalAIDirectFetch } = await loadModule()
    applyLocalAISettings()

    const fetch = createLocalAIDirectFetch(() => null)

    await expect(fetch(`${LOCAL_AI_DIRECT_ORIGIN}/health`)).rejects.toThrow(
      "No direct AI endpoint is configured",
    )
    expect(calls).toHaveLength(0)
  })

  it("drops the cached model list when the key changes, so a corrected key is retried at once", async () => {
    const replies = [
      new Response(JSON.stringify({ message: "nope" }), { status: 401 }),
      new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ]
    globalThis.fetch = vi.fn(
      async () => replies.shift() ?? new Response("{}", { status: 200 }),
    ) as unknown as typeof globalThis.fetch

    const { fetchUpstreamModelIds, resetModelListCache } =
      await import("@follow/store/ai-local/direct/config")
    const { setDirectApiKey } = await loadModule()
    resetModelListCache()

    const config = { baseUrl: "https://api.example.com/v1", model: "model-a", models: [] }

    // A rejected key is kept for a minute; replacing it must not keep reporting the rejection.
    await expect(
      fetchUpstreamModelIds(config, "wrong-key", globalThis.fetch),
    ).resolves.toMatchObject({
      rejected: true,
      ids: [],
    })

    setDirectApiKey("corrected-key")

    await expect(
      fetchUpstreamModelIds(config, "corrected-key", globalThis.fetch),
    ).resolves.toMatchObject({ rejected: false, ids: ["model-a", "model-b"] })
  })

  it("tells the user when the endpoint cannot be reached", async () => {
    mocks.settings = {
      ...defaultGatewaySettings(),
      enabled: true,
      directBaseUrl: "https://api.example.com/v1",
      directModel: "model-a",
    }
    mocks.toasts.length = 0
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Network request failed for the toast test")
    }) as unknown as typeof globalThis.fetch

    const { applyLocalAISettings } = await loadModule()
    applyLocalAISettings()

    // What the entry screens do when they need a summary; the failure has to become visible
    // instead of staying in the console.
    const { requestLocalAISummary } = await import("@follow/store/ai-local/client")
    const error = (await requestLocalAISummary({
      entryId: "entry-1",
      language: "en",
      target: "content",
      content: "x",
    }).catch((reason: Error) => reason)) as Error

    expect(mocks.toasts).toHaveLength(1)
    // The message names the endpoint the user configured, not the internal origin the store uses.
    expect(mocks.toasts[0]).toContain("https://api.example.com/v1")
    expect(mocks.toasts[0]).toContain("failed")
    expect(error.message).toContain("failed")
  })

  it("points the shared store at the configured endpoint once the settings are enabled", async () => {
    mocks.settings = {
      ...defaultGatewaySettings(),
      enabled: true,
      directBaseUrl: "https://api.example.com/v1",
      directModel: "model-a",
    }

    const { applyLocalAISettings, getDirectConfig } = await loadModule()

    expect(getDirectConfig()).toMatchObject({ baseUrl: "https://api.example.com/v1" })
    expect(applyLocalAISettings()).toMatchObject({
      mode: "direct",
      baseUrl: LOCAL_AI_DIRECT_ORIGIN,
    })
    // The runtime keeps a reporter, so a broken endpoint is not silent.
    expect(applyLocalAISettings().onError).toBeTypeOf("function")
  })

  it("leaves local AI off once the user turns it off", async () => {
    mocks.settings = {
      ...defaultGatewaySettings(),
      enabled: false,
      directBaseUrl: "https://api.example.com/v1",
    }

    const { applyLocalAISettings } = await loadModule()

    expect(applyLocalAISettings()).toMatchObject({ baseUrl: null, mode: "gateway" })
  })

  it("applies the gateway address that the build-time seed put into the settings", async () => {
    mocks.settings = {
      ...defaultGatewaySettings(),
      enabled: true,
      mode: "gateway",
      baseUrl: "http://192.168.1.20:8788",
      token: "seed-token",
    }

    const { applyLocalAISettings } = await loadModule()

    expect(applyLocalAISettings()).toMatchObject({
      mode: "gateway",
      baseUrl: "http://192.168.1.20:8788",
      token: "seed-token",
      fetch: undefined,
    })
  })
})
