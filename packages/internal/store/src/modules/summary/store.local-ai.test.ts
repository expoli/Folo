import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"

import { apiContext } from "../../context"
import type { FollowAPI } from "../../types"
import { configureLocalAI, resetLocalAI } from "../ai-local/config"
import { useEntryStore } from "../entry/store"
import type { EntryModel } from "../entry/types"
import { summarySyncService, useSummaryStore } from "./store"

const { insertSummaryMock } = vi.hoisted(() => ({
  insertSummaryMock: vi.fn(),
}))

vi.mock("@follow/database/services/summary", () => ({
  summaryService: {
    getAllSummaries: vi.fn(),
    insertSummary: insertSummaryMock,
    reset: vi.fn(),
  },
}))

const createEntry = (id: string): EntryModel => ({
  id,
  guid: `${id}-guid`,
  insertedAt: new Date("2026-01-01T00:00:00.000Z"),
  publishedAt: new Date("2026-01-01T00:00:00.000Z"),
  title: "Entry title",
  content: "Entry body",
})

describe("summarySyncService with a local AI gateway", () => {
  const entryId = "entry-local-1"
  const summaryApiMock = vi.fn()
  let server: ReturnType<typeof createServer>
  const gatewayRequests: { url?: string; body?: unknown }[] = []

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)

      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined
      gatewayRequests.push({ url: req.url, body })

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ code: 0, data: "Local summary" }))
    })

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  beforeEach(() => {
    vi.clearAllMocks()
    gatewayRequests.length = 0
    resetLocalAI()

    useEntryStore.setState({ data: { [entryId]: createEntry(entryId) } })
    useSummaryStore.setState({ data: {}, generatingStatus: {} })
    apiContext.provide({ ai: { summary: summaryApiMock } } as unknown as FollowAPI)
  })

  test("summarizes through the gateway and never calls Folo's API", async () => {
    const { port } = server.address() as AddressInfo
    configureLocalAI({ baseUrl: `http://127.0.0.1:${port}` })

    const summary = await summarySyncService.generateSummary({
      entryId,
      target: "content",
      actionLanguage: "zh-CN",
    })

    expect(summary).toBe("Local summary")
    expect(summaryApiMock).not.toHaveBeenCalled()
    expect(gatewayRequests).toHaveLength(1)
    expect(gatewayRequests[0]).toMatchObject({
      url: "/ai/summary",
      body: {
        entryId,
        language: "zh-CN",
        target: "content",
        title: "Entry title",
        content: "Entry body",
      },
    })
    expect(insertSummaryMock).toHaveBeenCalled()
  })

  test("falls back to Folo's AI when no gateway is configured", async () => {
    summaryApiMock.mockResolvedValue({ code: 0, data: "Server summary" })

    const summary = await summarySyncService.generateSummary({
      entryId,
      target: "content",
      actionLanguage: "zh-CN",
    })

    expect(summary).toBe("Server summary")
    expect(summaryApiMock).toHaveBeenCalledWith({
      id: entryId,
      language: "zh-CN",
      target: "content",
    })
    expect(gatewayRequests).toHaveLength(0)
  })
})
