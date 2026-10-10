import { beforeEach, describe, expect, test, vi } from "vitest"

import { AIPersistService } from "./index"

const { findFirstMock, deleteWhereMock, valuesMock, remoteDeleteMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  deleteWhereMock: vi.fn().mockResolvedValue(undefined),
  valuesMock: vi.fn().mockResolvedValue([]),
  remoteDeleteMock: vi.fn().mockResolvedValue({ success: true }),
}))

vi.mock("@follow/database/db", () => ({
  db: {
    delete: () => ({ where: deleteWhereMock }),
    values: valuesMock,
    query: { aiChatTable: { findFirst: findFirstMock } },
  },
}))

vi.mock("~/lib/api-client", () => ({
  followClient: { api: { aiChatSessions: { delete: remoteDeleteMock } } },
}))

vi.mock("~/i18n", () => ({
  getI18n: () => ({ t: (key: string) => key }),
}))

const createSession = (isLocal: boolean) => ({
  chatId: "chat-1",
  title: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  isLocal,
})

describe("AIPersistService remote deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test("never asks Folo to delete a local session", async () => {
    findFirstMock.mockResolvedValue(createSession(true))

    await AIPersistService.deleteSession("chat-1")

    expect(deleteWhereMock).toHaveBeenCalledTimes(2)
    expect(remoteDeleteMock).not.toHaveBeenCalled()
  })

  test("still deletes a synced session on Folo", async () => {
    findFirstMock.mockResolvedValue(createSession(false))

    await AIPersistService.deleteSession("chat-1")

    expect(remoteDeleteMock).toHaveBeenCalledWith({ chatId: "chat-1" })
  })

  test("cleanupEmptySessions only deletes synced sessions remotely", async () => {
    valuesMock.mockResolvedValue([
      ["chat-local", true],
      ["chat-remote", false],
    ])

    await AIPersistService.cleanupEmptySessions()

    expect(remoteDeleteMock).toHaveBeenCalledTimes(1)
    expect(remoteDeleteMock).toHaveBeenCalledWith({ chatId: "chat-remote" })
  })
})
