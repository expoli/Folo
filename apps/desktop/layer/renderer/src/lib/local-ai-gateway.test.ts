import { defaultAISettings } from "@follow/shared/settings/defaults"
import type { LocalAIGatewaySettings } from "@follow/shared/settings/interface"
import { LOCAL_AI_DIRECT_ORIGIN } from "@follow/shared/settings/local-ai"
import { getLocalAIConfig, isLocalAIEnabled, resetLocalAI } from "@follow/store/ai-local/config"
import { createDesktopAPIHeaders } from "@follow/utils/headers"
import type { ChatTransport, UIMessageChunk } from "ai"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { WebAISettings } from "~/atoms/settings/ai"
import {
  __aiSettingAtom,
  clearAISettings,
  getAISettings,
  initializeDefaultAISettings,
  setAISetting,
} from "~/atoms/settings/ai"
import { jotaiStore } from "~/lib/jotai"
import { queryClient } from "~/lib/query-client"
import { ChatSliceActions } from "~/modules/ai-chat/store/chat-core/chat-actions"
import { createAIChatStore } from "~/modules/ai-chat/store/store"
import { createChatTransport } from "~/modules/ai-chat/store/transport"
import type { BizUIMessage } from "~/modules/ai-chat/store/types"

import {
  applyLocalAIGatewaySettings,
  getDirectAIConfig,
  getLocalGatewaySettings,
  importLocalAIConfigFromByok,
  normalizeLocalGatewaySettings,
  subscribeLocalAIGatewaySettings,
} from "./local-ai-gateway"

const ipcServicesMock = vi.hoisted(() => ({
  localAI: {
    hasApiKey: vi.fn(),
    isSecureStorageAvailable: vi.fn(),
    setApiKey: vi.fn(),
    clearApiKey: vi.fn(),
    listModels: vi.fn(),
    request: vi.fn(),
    openChatStream: vi.fn(),
    closeChatStream: vi.fn(),
  },
}))

// `direct` mode reaches the model through the main process, never through the network.
vi.mock("~/lib/client", () => ({ ipcServices: ipcServicesMock }))

vi.mock("~/modules/ai-chat/services", () => ({
  AIPersistService: {
    markSessionSynced: vi.fn(),
    ensureSession: vi.fn(),
    replaceAllMessages: vi.fn(),
    updateSessionTitle: vi.fn(),
  },
}))

// The build-time env only seeds the first run; a saved gateway has to win over these values.
vi.mock("@follow/shared/env.desktop", () => ({
  env: {
    VITE_API_URL: "https://api.example.com",
    VITE_LOCAL_AI_GATEWAY_URL: "http://env-gateway.test:8788",
    VITE_LOCAL_AI_TOKEN: "env-token",
  },
}))

const transportOf = (store: ReturnType<typeof createAIChatStore>) => {
  const instance = store.getState().chatInstance
  return (instance as unknown as { transport: ChatTransport<BizUIMessage> }).transport
}

const sendOptions = () => ({
  chatId: "chat-1",
  messageId: undefined,
  messages: [],
  trigger: "submit-message" as const,
  abortSignal: undefined,
  headers: createDesktopAPIHeaders({ version: "1.0.0" }),
})

describe("local AI gateway wiring", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    resetLocalAI()
    clearAISettings()
    initializeDefaultAISettings()
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.close()
          },
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    ChatSliceActions.setActiveInstance(null)
  })

  test("starts from the build-time address", () => {
    expect(applyLocalAIGatewaySettings()).toEqual({
      baseUrl: "http://env-gateway.test:8788",
      token: "env-token",
      mode: "gateway",
    })
  })

  test("lets a saved gateway win over the build-time address", () => {
    setAISetting("localGateway", {
      ...defaultAISettings.localGateway,
      enabled: true,
      baseUrl: "  http://127.0.0.1:8788/  ",
      token: " token-1 ",
    })

    expect(applyLocalAIGatewaySettings()).toEqual({
      baseUrl: "http://127.0.0.1:8788",
      token: "token-1",
      mode: "gateway",
    })
  })

  test("returns the same object for the same stored settings", () => {
    // React consumers use the result as an effect dependency: a fresh object per call made their
    // draft-sync effect revert what the user was typing or pasting.
    const stored = {
      enabled: true,
      baseUrl: "http://127.0.0.1:8788",
    } as unknown as LocalAIGatewaySettings

    expect(normalizeLocalGatewaySettings(stored)).toBe(normalizeLocalGatewaySettings(stored))
  })

  test("fills the fields an object stored by an older version predates", () => {
    // The settings atom merges shallowly, so a saved object keeps its own shape and a field added
    // later is missing until it is normalised — reading `.trim()` on it used to crash the renderer.
    jotaiStore.set(__aiSettingAtom, {
      ...getAISettings(),
      localGateway: {
        enabled: true,
        baseUrl: "http://127.0.0.1:8788",
      } as unknown as LocalAIGatewaySettings,
    } as WebAISettings)

    const raw = getAISettings().localGateway
    // The stored object really is incomplete — this is what the settings section used to read.
    expect(raw.token).toBeUndefined()

    const normalized = normalizeLocalGatewaySettings(raw)
    expect(normalized).toMatchObject({ enabled: true, baseUrl: "http://127.0.0.1:8788" })
    expect(typeof normalized.token).toBe("string")
    expect(typeof normalized.directBaseUrl).toBe("string")
    expect(typeof normalized.directModel).toBe("string")
    expect(Array.isArray(normalized.directModels)).toBe(true)
    expect(() => getDirectAIConfig(getLocalGatewaySettings())).not.toThrow()
    expect(applyLocalAIGatewaySettings()).toMatchObject({ mode: "gateway" })
  })

  test("falls back to the build-time address for settings stored before the gateway existed", () => {
    const { localGateway: _gateway, ...legacy } = getAISettings()
    jotaiStore.set(__aiSettingAtom, legacy as WebAISettings)

    expect(applyLocalAIGatewaySettings()).toEqual({
      baseUrl: "http://env-gateway.test:8788",
      token: "env-token",
      mode: "gateway",
    })
  })

  test("keeps Folo's own AI while the gateway is switched off", () => {
    setAISetting("localGateway", {
      ...defaultAISettings.localGateway,
      enabled: false,
      baseUrl: "http://127.0.0.1:8788",
    })

    expect(applyLocalAIGatewaySettings()).toEqual({ baseUrl: null, token: null, mode: "gateway" })
    expect(isLocalAIEnabled()).toBe(false)
  })

  test("applies a saved gateway to the store, the model catalogue and every mounted chat", async () => {
    const store = createAIChatStore()
    store.setState({ chatId: "chat-1", isLocal: true })
    // A second mounted chat (another AI surface) has to be repointed as well.
    const secondaryStore = createAIChatStore()
    secondaryStore.setState({ chatId: "chat-2", isLocal: true })
    ChatSliceActions.registerInstance(store.getState().chatActions)
    ChatSliceActions.registerInstance(secondaryStore.getState().chatActions)

    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries")
    const unsubscribe = subscribeLocalAIGatewaySettings()

    setAISetting("localGateway", {
      ...defaultAISettings.localGateway,
      enabled: true,
      baseUrl: "http://127.0.0.1:8788",
      token: "token-1",
    })

    expect(getLocalAIConfig()).toEqual({
      baseUrl: "http://127.0.0.1:8788",
      token: "token-1",
      mode: "gateway",
    })
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["aiConfiguration"] })

    // The transport of every running chat is rebuilt, so the next request reaches the new gateway.
    for (const mounted of [store, secondaryStore]) {
      fetchMock.mockClear()
      await transportOf(mounted).sendMessages(sendOptions())

      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:8788/ai/chat",
        expect.objectContaining({
          credentials: "omit",
          headers: expect.objectContaining({ authorization: "Bearer token-1" }),
        }),
      )
    }

    ChatSliceActions.unregisterInstance(store.getState().chatActions)
    ChatSliceActions.unregisterInstance(secondaryStore.getState().chatActions)
    unsubscribe()
    invalidateQueries.mockRestore()
  })

  test("ignores AI settings that do not belong to the gateway", () => {
    const unsubscribe = subscribeLocalAIGatewaySettings()

    setAISetting("autoScrollWhenStreaming", false)

    expect(getLocalAIConfig()).toEqual({ baseUrl: null, token: null, mode: "gateway" })
    unsubscribe()
  })
})

describe("direct mode wiring", () => {
  const fetchMock = vi.fn()

  const directSettings = (
    changes: Partial<LocalAIGatewaySettings> = {},
  ): LocalAIGatewaySettings => ({
    ...defaultAISettings.localGateway,
    enabled: true,
    mode: "direct",
    directBaseUrl: "https://api.example.com/v1",
    directModel: "model-a",
    directModels: ["model-a", "model-b"],
    ...changes,
  })

  beforeEach(() => {
    resetLocalAI()
    clearAISettings()
    initializeDefaultAISettings()
    fetchMock.mockReset()
    ipcServicesMock.localAI.openChatStream.mockReset()
    vi.stubGlobal("fetch", fetchMock)
    ipcServicesMock.localAI.openChatStream.mockResolvedValue({
      streamId: null,
      status: 200,
      headers: {},
      body: "",
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    ChatSliceActions.setActiveInstance(null)
  })

  test("switches the runtime to the direct endpoint and keeps the fields saved", () => {
    setAISetting("localGateway", directSettings())

    const config = applyLocalAIGatewaySettings()

    expect(config).toMatchObject({
      mode: "direct",
      baseUrl: LOCAL_AI_DIRECT_ORIGIN,
      token: null,
    })
    expect(typeof config.fetch).toBe("function")
    expect(isLocalAIEnabled()).toBe(true)

    // The fields persist on the device, so the same endpoint comes back after a restart.
    expect(getAISettings().localGateway).toEqual(directSettings())
    expect(getDirectAIConfig()).toEqual({
      baseUrl: "https://api.example.com/v1",
      model: "model-a",
      models: ["model-a", "model-b"],
      // Nothing tuned yet: every knob stays with the built-in default in the main process.
      maxOutputTokens: null,
      temperature: null,
      reasoningEffort: null,
      extraRequestBody: null,
      summaryChunkChars: null,
      translationChunkChars: null,
      translationConcurrency: null,
    })
  })

  test("carries the advanced knobs with the request", () => {
    setAISetting(
      "localGateway",
      directSettings({
        directOptions: {
          maxOutputTokens: 4096,
          temperature: 0.2,
          reasoningEffort: "high",
          extraRequestBody: '{"thinking_budget":1024}',
          summaryChunkChars: 6000,
          translationChunkChars: 4000,
          translationConcurrency: 2,
        },
      }),
    )
    applyLocalAIGatewaySettings()

    expect(getDirectAIConfig()).toMatchObject({
      maxOutputTokens: 4096,
      temperature: 0.2,
      reasoningEffort: "high",
      extraRequestBody: '{"thinking_budget":1024}',
      summaryChunkChars: 6000,
      translationChunkChars: 4000,
      translationConcurrency: 2,
    })
  })

  test("fills the knobs of settings stored before they existed", () => {
    jotaiStore.set(__aiSettingAtom, {
      ...getAISettings(),
      localGateway: {
        enabled: true,
        mode: "direct",
        directBaseUrl: "https://api.example.com/v1",
      } as unknown as LocalAIGatewaySettings,
    } as WebAISettings)

    expect(getDirectAIConfig()).toMatchObject({
      maxOutputTokens: null,
      reasoningEffort: null,
      translationConcurrency: null,
    })
  })

  test("falls back to the gateway when the user switches the mode back", () => {
    setAISetting("localGateway", directSettings())
    applyLocalAIGatewaySettings()

    setAISetting("localGateway", {
      ...directSettings({ mode: "gateway" }),
      baseUrl: "http://127.0.0.1:8788",
      token: "token-1",
    })

    expect(applyLocalAIGatewaySettings()).toEqual({
      mode: "gateway",
      baseUrl: "http://127.0.0.1:8788",
      token: "token-1",
    })
  })

  test("keeps Folo's own AI while direct mode has no endpoint", () => {
    setAISetting("localGateway", directSettings({ directBaseUrl: "   " }))

    expect(applyLocalAIGatewaySettings()).toEqual({
      mode: "gateway",
      baseUrl: null,
      token: null,
    })
    expect(isLocalAIEnabled()).toBe(false)
    expect(getDirectAIConfig()).toBeNull()
  })

  test("derives the default model from the picked list when none is set", () => {
    expect(getDirectAIConfig(directSettings({ directModel: "" }))).toMatchObject({
      model: "model-a",
    })
  })

  test("sends the chat through the injected IPC transport instead of the network", async () => {
    const values: UIMessageChunk[] = []
    const streamListeners = new Map<string, (event: unknown, payload: unknown) => void>()
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

    ipcServicesMock.localAI.openChatStream.mockReset()
    ipcServicesMock.localAI.openChatStream.mockResolvedValue({
      streamId: "stream-1",
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: null,
    })

    // The transport reads the runtime config when it is created, so apply the settings first.
    setAISetting("localGateway", directSettings())
    applyLocalAIGatewaySettings()

    const transport = createChatTransport({ onValue: (chunk) => values.push(chunk) })
    const stream = await transport.sendMessages(sendOptions())

    // `sendMessages` only resolves the fetch; the UI chunks appear when its stream is consumed.
    await vi.waitFor(() => expect(streamListeners.size).toBe(1))
    for (const chunk of [
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", delta: "Hi" },
      { type: "text-end", id: "0" },
      { type: "finish", finishReason: "stop" },
    ]) {
      for (const listener of streamListeners.values()) {
        listener({}, { streamId: "stream-1", chunk: `data: ${JSON.stringify(chunk)}\n\n` })
      }
    }
    for (const listener of streamListeners.values()) {
      listener({}, { streamId: "stream-1", done: true })
    }

    const reader = stream.getReader()
    for (;;) {
      const { done } = await reader.read()
      if (done) break
    }

    expect(fetchMock).not.toHaveBeenCalled()
    expect(values).toContainEqual({ type: "text-delta", id: "0", delta: "Hi" })
    expect(ipcServicesMock.localAI.openChatStream).toHaveBeenCalledWith({
      body: expect.stringContaining('"messages"'),
      config: expect.objectContaining({
        baseUrl: "https://api.example.com/v1",
        model: "model-a",
        models: ["model-a", "model-b"],
      }),
    })
  })

  test("imports the endpoint and the key from BYOK once", async () => {
    ipcServicesMock.localAI.setApiKey.mockResolvedValue({ ok: true, hasApiKey: true })
    setAISetting("byok", {
      enabled: true,
      providers: [
        { provider: "google", apiKey: "google-key", baseURL: "https://generativelanguage.test" },
        {
          provider: "openrouter",
          apiKey: "  byok-key  ",
          baseURL: "https://openrouter.ai/api/v1/",
        },
      ],
    })

    await expect(importLocalAIConfigFromByok()).resolves.toEqual({
      ok: true,
      provider: "openrouter",
    })

    expect(ipcServicesMock.localAI.setApiKey).toHaveBeenCalledWith("byok-key")
    expect(getAISettings().localGateway).toMatchObject({
      enabled: true,
      mode: "direct",
      directBaseUrl: "https://openrouter.ai/api/v1",
      directModels: [],
      directModel: "",
    })
    // The import is a copy: the key is not kept in the settings.
    expect(JSON.stringify(getAISettings().localGateway)).not.toContain("byok-key")
  })

  test("imports a BYOK provider that left its address blank", async () => {
    ipcServicesMock.localAI.setApiKey.mockResolvedValue({ ok: true, hasApiKey: true })
    setAISetting("byok", { enabled: true, providers: [{ provider: "openai", apiKey: "byok-key" }] })

    await expect(importLocalAIConfigFromByok()).resolves.toEqual({ ok: true, provider: "openai" })
    expect(getAISettings().localGateway.directBaseUrl).toBe("https://api.openai.com/v1")
  })

  test("reports BYOK without a usable provider", async () => {
    setAISetting("byok", {
      enabled: true,
      providers: [{ provider: "google", apiKey: "google-key" }],
    })

    await expect(importLocalAIConfigFromByok()).resolves.toMatchObject({
      ok: false,
      reason: "no-provider",
    })
    expect(ipcServicesMock.localAI.setApiKey).not.toHaveBeenCalled()
    expect(getAISettings().localGateway.mode).toBe("gateway")
  })

  test("keeps the current settings when the key cannot be stored", async () => {
    ipcServicesMock.localAI.setApiKey.mockResolvedValue({
      ok: false,
      reason: "encryption-unavailable",
      message: "This system provides no keyring",
    })
    setAISetting("byok", {
      enabled: true,
      providers: [{ provider: "openai", apiKey: "byok-key", baseURL: "https://api.openai.com/v1" }],
    })

    await expect(importLocalAIConfigFromByok()).resolves.toEqual({
      ok: false,
      reason: "key-not-stored",
      message: "This system provides no keyring",
    })
    expect(getAISettings().localGateway).toMatchObject({ mode: "gateway", directBaseUrl: "" })
  })
})
