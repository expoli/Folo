import { getLocalAIConfig, isLocalAIEnabled, resetLocalAI } from "@follow/store/ai-local/config"
import { createDesktopAPIHeaders } from "@follow/utils/headers"
import type { ChatTransport } from "ai"
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
import type { BizUIMessage } from "~/modules/ai-chat/store/types"

import { applyLocalAIGatewaySettings, subscribeLocalAIGatewaySettings } from "./local-ai-gateway"

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
    })
  })

  test("lets a saved gateway win over the build-time address", () => {
    setAISetting("localGateway", {
      enabled: true,
      baseUrl: "  http://127.0.0.1:8788/  ",
      token: " token-1 ",
    })

    expect(applyLocalAIGatewaySettings()).toEqual({
      baseUrl: "http://127.0.0.1:8788",
      token: "token-1",
    })
  })

  test("falls back to the build-time address for settings stored before the gateway existed", () => {
    const { localGateway: _gateway, ...legacy } = getAISettings()
    jotaiStore.set(__aiSettingAtom, legacy as WebAISettings)

    expect(applyLocalAIGatewaySettings()).toEqual({
      baseUrl: "http://env-gateway.test:8788",
      token: "env-token",
    })
  })

  test("keeps Folo's own AI while the gateway is switched off", () => {
    setAISetting("localGateway", { enabled: false, baseUrl: "http://127.0.0.1:8788", token: "" })

    expect(applyLocalAIGatewaySettings()).toEqual({ baseUrl: null, token: null })
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
      enabled: true,
      baseUrl: "http://127.0.0.1:8788",
      token: "token-1",
    })

    expect(getLocalAIConfig()).toEqual({ baseUrl: "http://127.0.0.1:8788", token: "token-1" })
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

    expect(getLocalAIConfig()).toEqual({ baseUrl: null, token: null })
    unsubscribe()
  })
})
