import { summaryService } from "@follow/database/services/summary"
import { FollowAPIError } from "@follow-app/client-sdk"
import { beforeEach, describe, expect, test, vi } from "vitest"

import { apiContext } from "../../context"
import type { FollowAPI } from "../../types"
import { useEntryStore } from "../entry/store"
import type { EntryModel } from "../entry/types"
import { SummaryGeneratingStatus } from "./enum"
import { summaryActions, summarySyncService, useSummaryStore } from "./store"
import { getGenerateSummaryStatusId } from "./utils"

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
})

describe("summarySyncService", () => {
  const entryId = "entry-1"
  const actionLanguage = "en"
  const target = "content"
  const summaryApiMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()

    useEntryStore.setState({
      data: {
        [entryId]: createEntry(entryId),
      },
    })
    useSummaryStore.setState({
      data: {},
      generatingStatus: {},
    })
    apiContext.provide({
      ai: {
        summary: summaryApiMock,
      },
    } as unknown as FollowAPI)
  })

  test.each([
    { apiData: null, expected: null },
    { apiData: "", expected: null },
  ])(
    "treats empty API summary data as unavailable instead of payment failure",
    async ({ apiData, expected }) => {
      summaryApiMock.mockResolvedValue({ data: apiData })

      await expect(
        summarySyncService.generateSummary({
          entryId,
          target,
          actionLanguage,
        }),
      ).resolves.toBe(expected)

      expect(insertSummaryMock).not.toHaveBeenCalled()
      expect(
        useSummaryStore.getState().generatingStatus[
          getGenerateSummaryStatusId(entryId, actionLanguage, target)
        ],
      ).toBe(SummaryGeneratingStatus.Success)
    },
  )

  test("keeps real API payment errors for the upgrade prompt", async () => {
    const paymentError = new FollowAPIError("Payment required", 402)
    summaryApiMock.mockRejectedValue(paymentError)

    await expect(
      summarySyncService.generateSummary({
        entryId,
        target,
        actionLanguage,
      }),
    ).rejects.toBe(paymentError)

    expect(
      useSummaryStore.getState().generatingStatus[
        getGenerateSummaryStatusId(entryId, actionLanguage, target)
      ],
    ).toBe(SummaryGeneratingStatus.Error)
  })
})

describe("cached summaries", () => {
  const summary = (entryId: string) => ({
    entryId,
    language: "en" as const,
    summary: `Summary of ${entryId}`,
    readabilitySummary: null,
  })

  beforeEach(() => {
    useSummaryStore.setState({ data: {}, generatingStatus: {} })
  })

  test("drops the least recently used entries, which are entries and not languages", () => {
    vi.useFakeTimers({ toFake: ["Date"] })

    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
      summaryActions.upsertManyInSession(
        Array.from({ length: 10 }, (_, index) => summary(`entry-${index}`)),
      )

      // Reading the oldest entry again makes it the most recently used one.
      vi.setSystemTime(new Date("2026-01-01T00:01:00.000Z"))
      expect(summaryActions.getSummary("entry-0", "en")).toBeDefined()

      vi.setSystemTime(new Date("2026-01-01T00:02:00.000Z"))
      summaryActions.upsertManyInSession([summary("entry-new")])

      const { data } = useSummaryStore.getState()
      expect(Object.keys(data)).toHaveLength(10)
      expect(data["entry-0"]).toBeDefined()
      expect(data["entry-1"]).toBeUndefined()
      expect(data["entry-new"]).toBeDefined()
      // The pruning used to delete `data[language]`, which is never an entry id: a long session
      // kept every summary it had ever generated, and the language keys were the only thing it
      // could have hit.
      expect(data["en"]).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  test("reports a failing persistence instead of dropping it", async () => {
    // The persist callback used to drop its promise, so this rejection never reached the caller: it
    // surfaced as an unhandled rejection while the reset looked like it had succeeded.
    vi.mocked(summaryService.reset).mockRejectedValueOnce(new Error("no database"))

    await expect(summaryActions.reset()).rejects.toThrow("no database")
  })
})
