import { configureLocalAI, resetLocalAI } from "@follow/store/ai-local/config"
import { useEntryStore } from "@follow/store/entry/store"
import type { EntryModel } from "@follow/store/entry/types"
import { createDesktopAPIHeaders } from "@follow/utils/headers"
import type { ChatTransport } from "ai"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { createAIChatStore } from "../store"
import type { BizUIMessage } from "../types"

const { markSessionSyncedMock, ensureSessionMock, replaceAllMessagesMock } = vi.hoisted(() => ({
  markSessionSyncedMock: vi.fn(),
  ensureSessionMock: vi.fn(),
  replaceAllMessagesMock: vi.fn(),
}))

const { getFeedsMock } = vi.hoisted(() => ({ getFeedsMock: vi.fn() }))

vi.mock("~/lib/api-client", () => ({
  followClient: { api: { trending: { getFeeds: getFeedsMock } } },
}))

vi.mock("../../services", () => ({
  AIPersistService: {
    markSessionSynced: markSessionSyncedMock,
    ensureSession: ensureSessionMock,
    replaceAllMessages: replaceAllMessagesMock,
  },
}))

vi.mock("@follow/shared/env.desktop", () => ({
  env: { VITE_API_URL: "https://api.example.com", VITE_WEB_URL: "https://app.example.com" },
}))

const emptyStreamResponse = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.close()
      },
    }),
    { status: 200 },
  )

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

const createEntry = (id: string): EntryModel => ({
  id,
  guid: `${id}-guid`,
  insertedAt: new Date("2026-01-01T00:00:00.000Z"),
  publishedAt: new Date("2026-01-01T00:00:00.000Z"),
  title: `Title ${id}`,
  content: `Body ${id}`,
})

const createMessage = (id: string, role: "user" | "assistant", entryId?: string): BizUIMessage => ({
  id,
  role,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  parts: [
    ...(entryId
      ? ([
          {
            type: "data-block",
            data: [{ id: `block-${entryId}`, type: "mainEntry", value: entryId }],
          },
        ] as BizUIMessage["parts"])
      : []),
    { type: "text", text: `text of ${id}` },
  ],
})

describe("ChatSliceActions.markSessionSynced", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetLocalAI()
  })

  test("keeps a session local while the gateway is configured", async () => {
    configureLocalAI({ baseUrl: "http://127.0.0.1:8788" })
    const store = createAIChatStore()
    // Setting the id after creation keeps the store from probing for a resumable stream.
    store.setState({ chatId: "chat-1", isLocal: true })

    await store.getState().chatActions.markSessionSynced()

    expect(markSessionSyncedMock).not.toHaveBeenCalled()
    expect(store.getState().isLocal).toBe(true)
    expect(store.getState().syncStatus).toBe("local")
  })

  test("marks the session synced without a gateway", async () => {
    const store = createAIChatStore()
    store.setState({ chatId: "chat-1", isLocal: true })

    await store.getState().chatActions.markSessionSynced()

    expect(markSessionSyncedMock).toHaveBeenCalledWith("chat-1")
    expect(store.getState().isLocal).toBe(false)
    expect(store.getState().syncStatus).toBe("synced")
  })
})

describe("ChatSliceActions.regenerate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetLocalAI()
    useEntryStore.setState({
      data: { "entry-1": createEntry("entry-1"), "entry-2": createEntry("entry-2") },
    })
  })

  test("ships the context of the user message that asked the regenerated question", async () => {
    configureLocalAI({ baseUrl: "http://127.0.0.1:8788" })
    const store = createAIChatStore()
    store.setState({ chatId: "chat-1", isLocal: true })
    const regenerateMock = vi
      .spyOn(store.getState().chatInstance, "regenerate")
      .mockResolvedValue(undefined)

    store.getState().chatInstance.chatState.messages = [
      createMessage("user-1", "user", "entry-1"),
      createMessage("assistant-1", "assistant"),
      createMessage("user-2", "user", "entry-2"),
      createMessage("assistant-2", "assistant"),
    ]

    await store.getState().chatActions.regenerate({ messageId: "assistant-1" })

    expect(regenerateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "assistant-1",
        body: expect.objectContaining({
          localAIContext: expect.objectContaining({
            entries: [expect.objectContaining({ id: "entry-1", content: "Body entry-1" })],
          }),
        }),
      }),
    )
  })

  test("does not attach a context without a gateway", async () => {
    const store = createAIChatStore()
    store.setState({ chatId: "chat-1", isLocal: true })
    const regenerateMock = vi
      .spyOn(store.getState().chatInstance, "regenerate")
      .mockResolvedValue(undefined)

    await store.getState().chatActions.regenerate({ messageId: "assistant-1" })

    expect(regenerateMock).toHaveBeenCalledWith(
      expect.objectContaining({ body: { scene: "general" } }),
    )
  })

  test("ships the context with a new message, next to Folo's headers", async () => {
    configureLocalAI({ baseUrl: "http://127.0.0.1:8788" })
    const store = createAIChatStore()
    store.setState({ chatId: "chat-1", isLocal: true })
    const sendMock = vi
      .spyOn(store.getState().chatInstance, "sendMessage")
      .mockResolvedValue(undefined)

    await store.getState().chatActions.sendMessage(createMessage("user-1", "user", "entry-1"))

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user-1" }),
      expect.objectContaining({
        body: expect.objectContaining({
          localAIContext: expect.objectContaining({
            entries: [expect.objectContaining({ id: "entry-1", content: "Body entry-1" })],
          }),
        }),
        headers: expect.objectContaining({ "X-App-Name": "Folo Web" }),
      }),
    )
  })
})

// Folo's "Recommend feeds" shortcut expects the server to supply the catalogue to pick from; a
// local gateway has no such catalogue, so the client fetches and attaches it.
describe("ChatSliceActions.sendMessage with the recommend-feeds shortcut", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetLocalAI()
    useEntryStore.setState({ data: {} })
    getFeedsMock.mockResolvedValue({
      data: [
        {
          feedId: "feed-1",
          feed: {
            id: "feed-1",
            title: "Feed One",
            description: "A feed worth reading",
            url: "https://example.com/f1",
          },
        },
      ],
    })
  })

  test("attaches the catalogue the gateway cannot fetch itself", async () => {
    configureLocalAI({ baseUrl: "http://127.0.0.1:8788" })
    const store = createAIChatStore()
    store.setState({ chatId: "chat-feeds", isLocal: true })
    const sendMock = vi
      .spyOn(store.getState().chatInstance, "sendMessage")
      .mockResolvedValue(undefined)

    await store
      .getState()
      .chatActions.sendMessage(createMessage("default-recommend-feeds-message-1", "user"))

    expect(getFeedsMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: expect.objectContaining({
          localAIContext: expect.objectContaining({
            feeds: [expect.objectContaining({ id: "feed-1", title: "Feed One" })],
          }),
        }),
      }),
    )
  })

  test("detects the shortcut from the editor state when the id carries no prefix", async () => {
    configureLocalAI({ baseUrl: "http://127.0.0.1:8788" })
    const store = createAIChatStore()
    store.setState({ chatId: "chat-feeds-state", isLocal: true })
    const sendMock = vi
      .spyOn(store.getState().chatInstance, "sendMessage")
      .mockResolvedValue(undefined)

    const state = JSON.stringify({
      root: {
        children: [
          {
            children: [
              { shortcutData: { id: "default-recommend-feeds" }, type: "shortcut", version: 1 },
            ],
            type: "paragraph",
            version: 1,
          },
        ],
        type: "root",
        version: 1,
      },
    })

    await store.getState().chatActions.sendMessage({
      ...createMessage("message-without-prefix", "user"),
      parts: [{ type: "data-rich-text", data: { state, text: "pick 5 feeds" } }],
    } as BizUIMessage)

    expect(getFeedsMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: expect.objectContaining({
          localAIContext: expect.objectContaining({
            feeds: [expect.objectContaining({ id: "feed-1" })],
          }),
        }),
      }),
    )
  })

  test("keeps the catalogue attached on the follow-up turns", async () => {
    configureLocalAI({ baseUrl: "http://127.0.0.1:8788" })
    const store = createAIChatStore()
    store.setState({ chatId: "chat-feeds-followup", isLocal: true })
    const sendMock = vi
      .spyOn(store.getState().chatInstance, "sendMessage")
      .mockResolvedValue(undefined)
    store.getState().chatInstance.chatState.messages = [
      createMessage("default-recommend-feeds-message-3", "user"),
    ]

    await store.getState().chatActions.sendMessage(createMessage("user-answer", "user"))

    expect(sendMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: expect.objectContaining({
          localAIContext: expect.objectContaining({
            feeds: [expect.objectContaining({ id: "feed-1" })],
          }),
        }),
      }),
    )
  })

  test("does not call Folo for a catalogue without a gateway", async () => {
    const store = createAIChatStore()
    store.setState({ chatId: "chat-feeds-off", isLocal: true })
    const sendMock = vi
      .spyOn(store.getState().chatInstance, "sendMessage")
      .mockResolvedValue(undefined)

    await store
      .getState()
      .chatActions.sendMessage(createMessage("default-recommend-feeds-message-2", "user"))

    expect(getFeedsMock).not.toHaveBeenCalled()
    expect(sendMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ body: { scene: "general" } }),
    )
  })
})

describe("ChatSliceActions.recreateTransport", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    resetLocalAI()
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(emptyStreamResponse())
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test("points the next request at the newly saved gateway", async () => {
    configureLocalAI({ baseUrl: "http://127.0.0.1:8788" })
    const store = createAIChatStore()
    store.setState({ chatId: "chat-1", isLocal: true })

    configureLocalAI({ baseUrl: "http://127.0.0.1:9999", token: "token-2" })
    store.getState().chatActions.recreateTransport()

    await transportOf(store).sendMessages(sendOptions())

    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://127.0.0.1:9999/ai/chat",
      expect.objectContaining({
        credentials: "omit",
        headers: expect.objectContaining({ authorization: "Bearer token-2" }),
      }),
    )
  })

  test("waits for a running answer instead of cutting it off", async () => {
    configureLocalAI({ baseUrl: "http://127.0.0.1:8788" })
    const store = createAIChatStore()
    store.setState({ chatId: "chat-1", isLocal: true, status: "streaming" })
    const runningTransport = transportOf(store)

    configureLocalAI({ baseUrl: "http://127.0.0.1:9999", token: "token-2" })
    store.getState().chatActions.recreateTransport()

    // The answer in flight keeps the transport it started with.
    expect(transportOf(store)).toBe(runningTransport)

    store.setState({ status: "ready" })

    expect(transportOf(store)).not.toBe(runningTransport)

    await transportOf(store).sendMessages(sendOptions())

    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://127.0.0.1:9999/ai/chat",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer token-2" }),
      }),
    )
  })
})
