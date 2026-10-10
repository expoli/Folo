import { configureLocalAI, resetLocalAI } from "@follow/store/ai-local/config"
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  summaryTitle: vi.fn(),
  requestLocalAITitle: vi.fn(),
  updateSessionTitle: vi.fn(),
}))

vi.mock("~/lib/api-client", () => ({
  followClient: { api: { ai: { summaryTitle: mocks.summaryTitle } } },
}))

vi.mock("@follow/store/ai-local/client", () => ({
  requestLocalAITitle: mocks.requestLocalAITitle,
}))

vi.mock("../services", () => ({
  AIPersistService: { updateSessionTitle: mocks.updateSessionTitle },
}))

const { generateAndUpdateChatTitle } = await import("./titleGeneration")

const messages = [
  { id: "user-1", role: "user", parts: [{ type: "text", text: "What did I miss?" }] },
] as unknown as Parameters<typeof generateAndUpdateChatTitle>[1]

describe("chat title generation", () => {
  beforeEach(() => {
    resetLocalAI()
    vi.clearAllMocks()
  })

  test("writes the title with the local model when a gateway is configured", async () => {
    configureLocalAI({ baseUrl: "http://127.0.0.1:8788" })
    mocks.requestLocalAITitle.mockResolvedValue("Local title")

    const title = await generateAndUpdateChatTitle("chat-1", messages)

    expect(title).toBe("Local title")
    expect(mocks.requestLocalAITitle).toHaveBeenCalledWith({
      messages: [{ role: "user", content: "What did I miss?" }],
    })
    // Folo's own endpoint is not reachable from a local-only setup, so it must not be called.
    expect(mocks.summaryTitle).not.toHaveBeenCalled()
    expect(mocks.updateSessionTitle).toHaveBeenCalledWith("chat-1", "Local title")
  })

  test("keeps asking Folo without a gateway", async () => {
    mocks.summaryTitle.mockResolvedValue({ title: "Cloud title" })

    const title = await generateAndUpdateChatTitle("chat-2", messages)

    expect(title).toBe("Cloud title")
    expect(mocks.requestLocalAITitle).not.toHaveBeenCalled()
  })

  test("keeps the session title when the local model fails", async () => {
    configureLocalAI({ baseUrl: "http://127.0.0.1:8788" })
    mocks.requestLocalAITitle.mockRejectedValue(new Error("unreachable"))

    await expect(generateAndUpdateChatTitle("chat-3", messages)).resolves.toBeNull()
    expect(mocks.updateSessionTitle).not.toHaveBeenCalled()
  })
})
