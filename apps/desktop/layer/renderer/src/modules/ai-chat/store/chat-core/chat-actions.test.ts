import { FeedViewType } from "@follow/constants"
import { DEFAULT_SUMMARIZE_TIMELINE_SHORTCUT_ID } from "@follow/shared/settings/defaults"
import {
  configureLocalAI,
  resetLocalAI,
  setLocalAIContextBudget,
} from "@follow/store/ai-local/config"
import { useEntryStore } from "@follow/store/entry/store"
import type { EntryModel } from "@follow/store/entry/types"
import { createDesktopAPIHeaders } from "@follow/utils/headers"
import type { ChatTransport } from "ai"
import { createUIMessageStream, createUIMessageStreamResponse } from "ai"
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest"

import type { LocalAIContext } from "../../utils/local-ai-context"
import { createAIChatStore } from "../store"
import type { BizUIMessage } from "../types"
import { ChatSliceActions } from "./chat-actions"
import type { ZustandChat } from "./chat-instance"
import type { ChatSlice } from "./types"

const {
  markSessionSyncedMock,
  ensureSessionMock,
  replaceAllMessagesMock,
  getChatSessionMock,
  loadSessionWithMessagesMock,
} = vi.hoisted(() => ({
  markSessionSyncedMock: vi.fn(),
  ensureSessionMock: vi.fn(async () => {}),
  replaceAllMessagesMock: vi.fn(),
  getChatSessionMock: vi.fn(),
  loadSessionWithMessagesMock: vi.fn(),
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
    getChatSession: getChatSessionMock,
    loadSessionWithMessages: loadSessionWithMessagesMock,
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

  test("asks for the articles only a timeline summary cannot carry", async () => {
    configureLocalAI({ baseUrl: "http://127.0.0.1:8788" })
    setLocalAIContextBudget({ maxEntries: 1, maxTotalChars: 40 })
    useEntryStore.setState({
      entryIdByView: {
        [FeedViewType.All]: new Set(["entry-1", "entry-2"]),
      } as Record<FeedViewType, Set<string>>,
    })
    const store = createAIChatStore()
    store.setState({ chatId: "chat-1", isLocal: true, scene: "general" })
    const sendMock = vi
      .spyOn(store.getState().chatInstance, "sendMessage")
      .mockResolvedValue(undefined)

    // A timeline block scopes the request, so the second article falls outside the prompt budget.
    const message: BizUIMessage = {
      ...createMessage("user-1", "user"),
      parts: [
        {
          type: "data-block",
          data: [{ id: "block-view", type: "mainView", value: "-1" }],
        },
        { type: "text", text: "Summarize today" },
      ] as BizUIMessage["parts"],
    }

    await store.getState().chatActions.sendMessage(message)
    const plainBody = sendMock.mock.calls.at(-1)?.[1]?.body as {
      localAIContext?: { entries: { body?: unknown }[] }
    }
    expect(plainBody.localAIContext?.entries[1]).not.toHaveProperty("body")

    store.setState({ scene: "timeline-summary" })
    await store.getState().chatActions.sendMessage(message)
    const summaryBody = sendMock.mock.calls.at(-1)?.[1]?.body as {
      localAIContext?: { entries: { body?: unknown }[] }
    }
    // The summary asks for the text of the article the prompt could not carry.
    expect(summaryBody.localAIContext?.entries[1]?.body).toBe("Body entry-2")
  })

  test("reads the scene of the request, not the store's", async () => {
    configureLocalAI({ baseUrl: "http://127.0.0.1:8788" })
    setLocalAIContextBudget({ maxEntries: 1, maxTotalChars: 40 })
    useEntryStore.setState({
      entryIdByView: {
        [FeedViewType.All]: new Set(["entry-1", "entry-2"]),
      } as Record<FeedViewType, Set<string>>,
    })
    const store = createAIChatStore()
    // A shortcut asks for a summary per request and leaves the store on "general".
    store.setState({ chatId: "chat-1", isLocal: true, scene: "general" })
    const sendMock = vi
      .spyOn(store.getState().chatInstance, "sendMessage")
      .mockResolvedValue(undefined)

    const message: BizUIMessage = {
      ...createMessage("user-1", "user"),
      parts: [
        {
          type: "data-block",
          data: [{ id: "block-view", type: "mainView", value: "-1" }],
        },
        { type: "text", text: "Summarize today" },
      ] as BizUIMessage["parts"],
    }

    await store.getState().chatActions.sendMessage(message, {
      body: { scene: "timeline-summary" },
    })

    const body = sendMock.mock.calls.at(-1)?.[1]?.body as {
      localAIContext?: { entries: { body?: unknown }[] }
    }
    expect(body.localAIContext?.entries[1]?.body).toBe("Body entry-2")
  })

  test("carries the context into the request a tool approval continues", async () => {
    configureLocalAI({ baseUrl: "http://127.0.0.1:8788" })
    const store = createAIChatStore()
    store.setState({ chatId: "chat-1", isLocal: true })
    const approvalMock = vi
      .spyOn(store.getState().chatInstance, "addToolApprovalResponse")
      .mockResolvedValue(undefined)
    store.getState().chatInstance.chatState.messages = [
      createMessage("user-1", "user", "entry-1"),
      createMessage("assistant-1", "assistant"),
    ]

    await store.getState().chatActions.addToolApprovalResponse({
      id: "approval-1",
      approved: true,
    })

    expect(approvalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "approval-1",
        approved: true,
        options: expect.objectContaining({
          body: expect.objectContaining({
            localAIContext: expect.objectContaining({
              entries: [expect.objectContaining({ id: "entry-1" })],
            }),
          }),
        }),
      }),
    )
  })

  test("sends no options for a tool approval without a gateway", async () => {
    const store = createAIChatStore()
    store.setState({ chatId: "chat-1", isLocal: true })
    const approvalMock = vi
      .spyOn(store.getState().chatInstance, "addToolApprovalResponse")
      .mockResolvedValue(undefined)

    await store.getState().chatActions.addToolApprovalResponse({
      id: "approval-1",
      approved: true,
    })

    expect(approvalMock).toHaveBeenCalledWith({ id: "approval-1", approved: true })
  })
})

describe("ChatSliceActions request scene continuity", () => {
  const requests: {
    scene: string
    localAIContext?: LocalAIContext
    messages: BizUIMessage[]
  }[] = []
  let approvalRequests: number[]

  const streamResponse = (approvalRequested: boolean) =>
    createUIMessageStreamResponse({
      stream: createUIMessageStream({
        execute: ({ writer }) => {
          writer.write({ type: "start", messageId: "assistant-scene" })
          writer.write({ type: "start-step" })
          if (approvalRequested) {
            writer.write({
              type: "tool-input-available",
              toolName: "mcp_write",
              toolCallId: "tool-scene",
              input: {},
              dynamic: true,
            })
            writer.write({
              type: "tool-approval-request",
              approvalId: "approval-scene",
              toolCallId: "tool-scene",
            })
          } else {
            writer.write({ type: "text-start", id: "reply-scene" })
            writer.write({ type: "text-delta", id: "reply-scene", delta: "Done" })
            writer.write({ type: "text-end", id: "reply-scene" })
          }
          writer.write({ type: "finish-step" })
          writer.write({ type: "finish", finishReason: approvalRequested ? "tool-calls" : "stop" })
        },
      }),
    })

  const timelineMessage = (shortcut = true): BizUIMessage => ({
    ...createMessage("user-scene", "user"),
    parts: [
      {
        type: "data-block",
        data: [{ id: "block-view", type: "mainView", value: "-1" }],
      },
      shortcut
        ? {
            type: "data-rich-text",
            data: {
              text: "Summarize today",
              state: JSON.stringify({
                root: {
                  type: "root",
                  version: 1,
                  children: [
                    {
                      type: "paragraph",
                      version: 1,
                      children: [
                        {
                          type: "shortcut",
                          version: 1,
                          shortcutData: { id: DEFAULT_SUMMARIZE_TIMELINE_SHORTCUT_ID },
                        },
                      ],
                    },
                  ],
                },
              }),
            },
          }
        : { type: "text", text: "Summarize today" },
    ],
  })

  const approve = async (getState: () => ChatSlice) => {
    const nextRequestCount = requests.length + 1
    await getState().chatActions.addToolApprovalResponse({
      id: "approval-scene",
      approved: true,
    })
    await vi.waitFor(() => {
      expect(requests).toHaveLength(nextRequestCount)
      expect(getState().status).toBe("ready")
    })
    expect(requests.at(-1)?.messages.at(-1)?.parts).toContainEqual(
      expect.objectContaining({
        state: "approval-responded",
        approval: { id: "approval-scene", approved: true },
      }),
    )
  }

  beforeEach(() => {
    vi.clearAllMocks()
    resetLocalAI()
    configureLocalAI({ baseUrl: "http://127.0.0.1:8788" })
    setLocalAIContextBudget({ maxEntries: 1, maxTotalChars: 40 })
    useEntryStore.setState({
      data: { "entry-1": createEntry("entry-1"), "entry-2": createEntry("entry-2") },
      entryIdByView: {
        [FeedViewType.All]: new Set(["entry-1", "entry-2"]),
      } as Record<FeedViewType, Set<string>>,
    })
    requests.length = 0
    approvalRequests = [1]
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (!init?.body) return new Response(null, { status: 204 })
        requests.push(JSON.parse(init.body as string))
        return streamResponse(approvalRequests.includes(requests.length))
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetLocalAI()
  })

  test.each([
    {
      name: "summary shortcut without options",
      shortcut: true,
      requestedScene: undefined,
      storeScene: "general",
      expectedScene: "timeline-summary",
    },
    {
      name: "explicit general over a summary shortcut",
      shortcut: true,
      requestedScene: "general",
      storeScene: "general",
      expectedScene: "general",
    },
    {
      name: "explicit onboarding over a summary shortcut",
      shortcut: true,
      requestedScene: "onboarding",
      storeScene: "general",
      expectedScene: "onboarding",
    },
    {
      name: "explicit summary without a shortcut",
      shortcut: false,
      requestedScene: "timeline-summary",
      storeScene: "general",
      expectedScene: "timeline-summary",
    },
    {
      name: "ordinary general chat",
      shortcut: false,
      requestedScene: undefined,
      storeScene: "general",
      expectedScene: "general",
    },
    {
      name: "ordinary onboarding chat",
      shortcut: false,
      requestedScene: undefined,
      storeScene: "onboarding",
      expectedScene: "onboarding",
    },
  ] as const)(
    "keeps $name consistent on send, approval and regenerate",
    async ({ shortcut, requestedScene, storeScene, expectedScene }) => {
      const store = createAIChatStore()
      store.setState({ scene: storeScene })

      // Keep the real SDK, transport and context builder: the gateway sees the serialized request,
      // and an actual approval stream must drive the next request without replacing an action.
      await store
        .getState()
        .chatActions.sendMessage(
          timelineMessage(shortcut),
          requestedScene ? { body: { scene: requestedScene } } : undefined,
        )
      expect(store.getState().messages.at(-1)?.parts).toContainEqual(
        expect.objectContaining({ state: "approval-requested" }),
      )
      await approve(store.getState)
      await store.getState().chatActions.regenerate({ messageId: "assistant-scene" })

      expect(requests).toHaveLength(3)
      for (const request of requests) {
        expect(request.scene).toBe(expectedScene)
        expect(request.localAIContext?.fetchBodies === true).toBe(
          expectedScene === "timeline-summary",
        )
        expect(request.localAIContext?.entries.find((entry) => entry.id === "entry-2")?.body).toBe(
          expectedScene === "timeline-summary" ? "Body entry-2" : undefined,
        )
      }
      expect(store.getState().scene).toBe(storeScene)
    },
  )

  test("preserves the official chat scene when a timeline shortcut is sent", async () => {
    resetLocalAI()
    const store = createAIChatStore()

    await store.getState().chatActions.sendMessage(timelineMessage())

    expect(requests[0]?.scene).toBe("general")
    expect(requests[0]?.localAIContext).toBeUndefined()
  })

  test("uses an explicit regenerate scene for its context and later approval", async () => {
    approvalRequests.push(2)
    const store = createAIChatStore()
    await store.getState().chatActions.sendMessage(timelineMessage())

    await store.getState().chatActions.regenerate({
      messageId: "assistant-scene",
      body: { scene: "general" },
    })
    await approve(store.getState)
    await store.getState().chatActions.regenerate({ messageId: "assistant-scene" })

    expect(requests.map((request) => request.scene)).toEqual([
      "timeline-summary",
      "general",
      "general",
      "general",
    ])
    expect(requests[0]?.localAIContext?.fetchBodies).toBe(true)
    for (const request of requests.slice(1)) {
      expect(request.localAIContext?.fetchBodies).not.toBe(true)
      expect(
        request.localAIContext?.entries.find((entry) => entry.id === "entry-2")?.body,
      ).toBeUndefined()
    }
  })

  test("retains an explicit scene for string messages using the SDK's generated id", async () => {
    const store = createAIChatStore({ generateId: () => "generated-user-scene" })
    await store.getState().chatActions.sendMessage("Summarize today", {
      body: { scene: "timeline-summary" },
    })
    expect(store.getState().messages[0]?.id).toBe("generated-user-scene")
    await approve(store.getState)
    await store.getState().chatActions.regenerate({ messageId: "assistant-scene" })
    expect(requests.map((request) => request.scene)).toEqual([
      "timeline-summary",
      "timeline-summary",
      "timeline-summary",
    ])
  })

  test("discards a scene when sending fails before the SDK stores the user message", async () => {
    const store = createAIChatStore()
    const sendMock = vi
      .spyOn(store.getState().chatInstance, "sendMessage")
      .mockRejectedValueOnce(new Error("not queued"))
    await expect(
      store.getState().chatActions.sendMessage(timelineMessage(), {
        body: { scene: "general" },
      }),
    ).rejects.toThrow("not queued")
    sendMock.mockRestore()

    store.getState().chatActions.setMessages([timelineMessage()])
    await store.getState().chatActions.regenerate({ messageId: "user-scene" })
    expect(requests[0]?.scene).toBe("timeline-summary")
    expect(requests[0]?.localAIContext?.fetchBodies).toBe(true)
  })

  test.each(["newChat", "switchToChat"] as const)(
    "clears live scene overrides on %s",
    async (action) => {
      const store = createAIChatStore()
      const { chatActions } = store.getState()
      await chatActions.sendMessage(timelineMessage(), { body: { scene: "general" } })

      if (action === "newChat") {
        await chatActions.newChat()
        chatActions.setMessages([timelineMessage()])
      } else {
        loadSessionWithMessagesMock.mockResolvedValueOnce({
          session: null,
          messages: [timelineMessage()],
        })
        await chatActions.switchToChat("another-scene-chat")
      }

      await chatActions.regenerate({ messageId: "user-scene" })
      expect(requests.map((request) => request.scene)).toEqual(["general", "timeline-summary"])
      expect(requests[1]?.localAIContext?.fetchBodies).toBe(true)
    },
  )
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

type TestState = Pick<ChatSlice, "chatId" | "currentTitle">

const createActions = (state: TestState, messages: unknown[] = [{ id: "m1", parts: [] }]) => {
  const set = (updater: (state: TestState) => TestState) => {
    Object.assign(state, updater(state))
  }
  const get = () => state
  const chatInstance = { chatState: { messages } } as unknown as ZustandChat
  return new ChatSliceActions([set, get, {}] as never, { chatInstance, hasChatId: false })
}

describe("ChatSliceActions.adoptStoredTitle", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getChatSessionMock.mockResolvedValue({ chatId: "chat-1", title: "9 PM Oct 12, 2026 chat" })
  })

  it("names an untitled chat after its stored session, as the chat history does", async () => {
    const state: TestState = { chatId: "chat-1", currentTitle: undefined }
    await createActions(state).adoptStoredTitle("chat-1")

    expect(ensureSessionMock).toHaveBeenCalledWith("chat-1")
    expect(state.currentTitle).toBe("9 PM Oct 12, 2026 chat")
  })

  it("keeps a title the chat already has", async () => {
    const state: TestState = { chatId: "chat-1", currentTitle: "Generated title" }
    await createActions(state).adoptStoredTitle("chat-1")

    expect(state.currentTitle).toBe("Generated title")
    expect(getChatSessionMock).not.toHaveBeenCalled()
  })

  it("leaves an empty chat and a chat that is no longer shown alone", async () => {
    const empty: TestState = { chatId: "chat-1", currentTitle: undefined }
    await createActions(empty, []).adoptStoredTitle("chat-1")
    expect(empty.currentTitle).toBeUndefined()

    const switched: TestState = { chatId: "chat-1", currentTitle: undefined }
    const actions = createActions(switched)
    getChatSessionMock.mockImplementation(async () => {
      switched.chatId = "chat-2"
      return { chatId: "chat-1", title: "Old chat" }
    })
    await actions.adoptStoredTitle("chat-1")
    expect(switched.currentTitle).toBeUndefined()
  })
})
