import type { LocalAIGatewaySettings } from "@follow/shared/settings/interface"
import type { LocalAIDirectConfig } from "@follow/shared/settings/local-ai"
import { LOCAL_AI_DIRECT_ORIGIN } from "@follow/shared/settings/local-ai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  class SecureStorageUnavailableError extends Error {
    constructor() {
      super("The OS keychain is not available, and storing the value unencrypted was refused")
      this.name = "SecureStorageUnavailableError"
    }
  }

  return {
    settings: null as LocalAIGatewaySettings | null,
    apiKey: null as string | null,
    /** Whether the OS keychain works; when it does not, only the strict caller sees nothing. */
    keychain: true,
    defaults: null as LocalAIGatewaySettings | null,
    toasts: [] as string[],
    resetTranslations: vi.fn(),
    resetSummaries: vi.fn(),
    setGatewaySetting: vi.fn(),
    readCalls: [] as { key: string; strict: boolean }[],
    writeCalls: [] as { key: string; value: string; strict: boolean }[],
    setError: null as Error | null,
    SecureStorageUnavailableError,
  }
})

// The real stores reach the SQLite service, and through it the build-time globals the app defines;
// this module only needs to know that they are asked to drop their cached text.
vi.mock("@follow/store/translation/store", () => ({
  translationActions: { reset: mocks.resetTranslations, removeTranslation: vi.fn() },
  translationSyncService: { generateTranslation: vi.fn() },
}))

vi.mock("@follow/store/summary/store", () => ({
  summaryActions: { reset: mocks.resetSummaries },
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
  SecureStorageUnavailableError: mocks.SecureStorageUnavailableError,
  safeSecureStore: {
    getItem: (key: string, options?: { allowInsecureFallback?: boolean }) => {
      const strict = options?.allowInsecureFallback === false
      mocks.readCalls.push({ key, strict })
      // A caller that refuses the fallback only ever sees what the keychain holds.
      if (strict && !mocks.keychain) return null

      return key === "follow_local_ai_direct_api_key" ? mocks.apiKey : null
    },
    setItem: (key: string, value: string, options?: { allowInsecureFallback?: boolean }) => {
      mocks.writeCalls.push({ key, value, strict: options?.allowInsecureFallback === false })
      if (mocks.setError) throw mocks.setError
    },
    removeItem: vi.fn(),
  },
}))

vi.mock("@/src/atoms/settings/ai", () => ({
  createDefaultAISettings: () => ({ localGateway: mocks.defaults }),
  getAISettings: () => ({ localGateway: mocks.settings }),
  setLocalAIGatewaySetting: mocks.setGatewaySetting,
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
    mocks.keychain = true
    mocks.readCalls.length = 0
    mocks.writeCalls.length = 0
    mocks.setError = null
    mocks.setGatewaySetting.mockReset()
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

    const { fetchUpstreamModelIds, resetModelListCache } = await import("@follow/ai-runtime/config")
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

  it("drops cached AI text when the model changes, and keeps it when local AI is switched off", async () => {
    mocks.settings = {
      ...defaultGatewaySettings(),
      enabled: true,
      directBaseUrl: "https://api.example.com/v1",
      directModel: "model-a",
    }

    const { applyLocalAISettings } = await loadModule()

    // Align the module with this endpoint first, then watch the next calls.
    applyLocalAISettings()
    vi.clearAllMocks()

    applyLocalAISettings()
    expect(mocks.resetTranslations).not.toHaveBeenCalled()

    mocks.settings = { ...mocks.settings, directModel: "model-b" }
    applyLocalAISettings()
    expect(mocks.resetTranslations).toHaveBeenCalledTimes(1)
    expect(mocks.resetSummaries).toHaveBeenCalledTimes(1)

    // A free account could not regenerate what it loses, so turning local AI off keeps the text.
    mocks.settings = { ...mocks.settings, enabled: false }
    applyLocalAISettings()
    expect(mocks.resetTranslations).toHaveBeenCalledTimes(1)
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

describe("mobile Local AI storage and switching", () => {
  beforeEach(() => {
    mocks.settings = defaultGatewaySettings()
    mocks.defaults = defaultGatewaySettings()
    mocks.apiKey = null
    mocks.keychain = true
    mocks.readCalls.length = 0
    mocks.writeCalls.length = 0
    mocks.setError = null
    mocks.setGatewaySetting.mockReset()
  })

  it("reads the API key from the keychain only", async () => {
    mocks.apiKey = "sk-real"
    const { getDirectApiKey } = await loadModule()

    expect(getDirectApiKey()).toBe("sk-real")
    expect(mocks.readCalls).toEqual([{ key: "follow_local_ai_direct_api_key", strict: true }])
  })

  it("never reads a plaintext copy of the key", async () => {
    // An earlier build stored the key unencrypted because the keychain was missing.
    mocks.apiKey = "sk-plaintext"
    mocks.keychain = false
    const { getDirectApiKey } = await loadModule()

    expect(getDirectApiKey()).toBeNull()
    expect(mocks.readCalls.every((call) => call.strict)).toBe(true)
  })

  it("reports that it will not store the key unencrypted", async () => {
    mocks.setError = new mocks.SecureStorageUnavailableError()
    const { setDirectApiKey } = await loadModule()

    expect(setDirectApiKey("sk-secret")).toMatchObject({
      ok: false,
      reason: "encryption-unavailable",
    })
    // It asked for the strict write, which is what refused to keep the secret.
    expect(mocks.writeCalls).toEqual([
      { key: "follow_local_ai_direct_api_key", value: "sk-secret", strict: true },
    ])
  })

  it("saves the key when the keychain works, and clears it when the field is emptied", async () => {
    const { setDirectApiKey } = await loadModule()

    expect(setDirectApiKey(" sk-secret ")).toEqual({ ok: true, hasApiKey: true })
    expect(mocks.writeCalls[0]).toMatchObject({ value: "sk-secret", strict: true })

    expect(setDirectApiKey("")).toEqual({ ok: true, hasApiKey: false })
  })

  it("keeps the configured gateway mode when local AI is switched off and on", async () => {
    mocks.settings = {
      ...defaultGatewaySettings(),
      enabled: true,
      mode: "gateway",
      baseUrl: "http://192.168.1.20:8788",
      token: "seed-token",
    }

    const { applyLocalAISettings, setLocalAIEnabled } = await loadModule()

    setLocalAIEnabled(false)
    setLocalAIEnabled(true)

    // The switch writes `enabled` and nothing else: rewriting `mode` here is what used to turn a
    // configured gateway into a direct endpoint.
    expect(mocks.setGatewaySetting.mock.calls).toEqual([[{ enabled: false }], [{ enabled: true }]])
    expect(applyLocalAISettings()).toMatchObject({
      mode: "gateway",
      baseUrl: "http://192.168.1.20:8788",
      token: "seed-token",
    })
  })

  it("cancels the requests of the previous endpoint when the model changes", async () => {
    mocks.settings = {
      ...defaultGatewaySettings(),
      enabled: true,
      directBaseUrl: "https://api.example.com/v1",
      directModel: "model-a",
    }
    const { applyLocalAISettings } = await loadModule()
    const { getLocalAIRequestSignal } = await import("@follow/store/ai-local/config")

    applyLocalAISettings()
    const signal = getLocalAIRequestSignal()

    mocks.settings = { ...mocks.settings, directModel: "model-b" }
    applyLocalAISettings()

    expect(signal.aborted).toBe(true)
    expect(getLocalAIRequestSignal().aborted).toBe(false)
  })
})
