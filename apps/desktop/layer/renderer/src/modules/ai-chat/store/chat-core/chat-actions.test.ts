import { configureLocalAI, resetLocalAI } from "@follow/store/ai-local/config"
import { useEntryStore } from "@follow/store/entry/store"
import type { EntryModel } from "@follow/store/entry/types"
import { beforeEach, describe, expect, test, vi } from "vitest"

import { createAIChatStore } from "../store"
import type { BizUIMessage } from "../types"

const { markSessionSyncedMock, ensureSessionMock, replaceAllMessagesMock } = vi.hoisted(() => ({
  markSessionSyncedMock: vi.fn(),
  ensureSessionMock: vi.fn(),
  replaceAllMessagesMock: vi.fn(),
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
