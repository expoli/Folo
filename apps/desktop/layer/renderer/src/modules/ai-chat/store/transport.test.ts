import { configureLocalAI, resetLocalAI } from "@follow/store/ai-local/config"
import { createDesktopAPIHeaders } from "@follow/utils/headers"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { createChatTransport } from "./transport"

vi.mock("../services", () => ({
  AIPersistService: { updateSessionTitle: vi.fn() },
}))

vi.mock("@follow/shared/env.desktop", () => ({
  env: { VITE_API_URL: "https://api.example.com" },
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

const desktopHeaders = () => createDesktopAPIHeaders({ version: "1.0.0" })

const sendOptions = (trigger: "submit-message" | "regenerate-message") => ({
  chatId: "chat-1",
  messageId: trigger === "regenerate-message" ? "message-1" : undefined,
  messages: [],
  trigger,
  abortSignal: undefined,
  headers: desktopHeaders(),
})

describe("createChatTransport", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    resetLocalAI()
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(emptyStreamResponse())
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test("sends the gateway token on send, regenerate and resume, next to Folo's headers", async () => {
    configureLocalAI({ baseUrl: "http://127.0.0.1:8788", token: "token-1" })
    const transport = createChatTransport()

    await transport.sendMessages(sendOptions("submit-message"))
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://127.0.0.1:8788/ai/chat",
      expect.objectContaining({
        credentials: "omit",
        headers: expect.objectContaining({
          authorization: "Bearer token-1",
          // Per-request desktop headers must survive next to the transport-level gateway token.
          "x-app-version": "1.0.0",
          "cache-control": "no-store",
        }),
      }),
    )

    await transport.sendMessages(sendOptions("regenerate-message"))
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://127.0.0.1:8788/ai/chat",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer token-1" }),
      }),
    )

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await expect(transport.reconnectToStream({ chatId: "chat-1" })).resolves.toBeNull()
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://127.0.0.1:8788/ai/chat/chat-1/stream",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer token-1" }),
      }),
    )
  })

  test("keeps Folo's API, cookies and headers when no gateway is configured", async () => {
    const transport = createChatTransport()

    await transport.sendMessages(sendOptions("submit-message"))

    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://api.example.com/ai/chat",
      expect.objectContaining({
        credentials: "include",
        headers: expect.not.objectContaining({ authorization: expect.anything() }),
      }),
    )
    expect(fetchMock.mock.lastCall?.[1]?.headers).toMatchObject({ "cache-control": "no-store" })
  })
})
