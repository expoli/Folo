import { configureLocalAI, resetLocalAI } from "@follow/store/ai-local/config"
import { beforeEach, describe, expect, test, vi } from "vitest"

import { AIChatSessionService } from "./service"

const { listMock, getChatSessionsMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  getChatSessionsMock: vi.fn(),
}))

vi.mock("~/lib/api-client", () => ({
  followApi: { aiChatSessions: { list: listMock } },
}))

vi.mock("~/modules/ai-chat/services", () => ({
  AIPersistService: { getChatSessions: getChatSessionsMock },
}))

describe("AIChatSessionService with a local AI gateway", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetLocalAI()
    getChatSessionsMock.mockResolvedValue([])
    listMock.mockResolvedValue({ data: [] })
  })

  test("keeps sessions local: reloads the database and never asks Folo", async () => {
    configureLocalAI({ baseUrl: "http://127.0.0.1:8788" })
    getChatSessionsMock.mockResolvedValue([{ chatId: "chat-1" }])

    const sessions = await AIChatSessionService.syncSessionsAndMessagesFromServer()

    expect(sessions).toEqual([])
    expect(getChatSessionsMock).toHaveBeenCalledTimes(1)
    expect(listMock).not.toHaveBeenCalled()
  })

  test("still syncs from Folo when no gateway is configured", async () => {
    await AIChatSessionService.syncSessionsAndMessagesFromServer()

    expect(listMock).toHaveBeenCalledTimes(1)
  })
})
