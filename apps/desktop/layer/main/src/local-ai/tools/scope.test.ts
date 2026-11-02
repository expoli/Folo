import { describe, expect, test, vi } from "vitest"

import type { LocalAgentReadingToolHandlers } from "~/local-agent-reading/server"

import { scopeFromContext, scopeFromContextBlocks, withDefaultScope } from "./scope"

const handlers = (
  overrides: Partial<LocalAgentReadingToolHandlers> = {},
): LocalAgentReadingToolHandlers => ({
  status: async () => ({ signedIn: true }) as never,
  beginScan: async () => ({ ok: true, data: { scanId: "scan-1" } }) as never,
  listEntries: async () => ({ ok: true, data: { entries: [] } }) as never,
  getContents: async () => ({ ok: true, data: { items: [] } }) as never,
  ...overrides,
})

describe("scopeFromContextBlocks", () => {
  test("reads a single feed", () => {
    expect(scopeFromContextBlocks([{ type: "mainFeed", value: "feed-1" }])).toEqual({
      feedIds: ["feed-1"],
    })
  })

  test("splits a folder's comma-joined feed ids and drops duplicates", () => {
    expect(scopeFromContextBlocks([{ type: "mainFeed", value: "feed-1, feed-2,feed-1" }])).toEqual({
      feedIds: ["feed-1", "feed-2"],
    })
  })

  test("keeps only the feeds when a view is attached too", () => {
    expect(
      scopeFromContextBlocks([
        { type: "mainView", value: "0" },
        { type: "mainFeed", value: "feed-1" },
        { type: "unreadOnly", value: "true" },
      ]),
    ).toEqual({ feedIds: ["feed-1"] })
  })

  test("falls back to the view without a feed", () => {
    expect(
      scopeFromContextBlocks([
        { type: "mainView", value: "2" },
        { type: "unreadOnly", value: "true" },
      ]),
    ).toEqual({ views: [2] })
  })

  test("is undefined without a timeline block", () => {
    expect(scopeFromContextBlocks(undefined)).toBeUndefined()
    expect(scopeFromContextBlocks([])).toBeUndefined()
    expect(scopeFromContextBlocks([{ type: "mainEntry", value: "entry-1" }])).toBeUndefined()
    expect(scopeFromContextBlocks([{ type: "mainView", value: "not-a-view" }])).toBeUndefined()
  })
})

describe("scopeFromContext", () => {
  const blocks = [{ type: "mainFeed", value: "feed-1" }]

  test("scopes a scan to the period the prompt named", () => {
    const scope = scopeFromContext({
      blocks,
      coverage: {
        matched: 3,
        window: "2026-10-30",
        publishedAfter: "2026-10-30T00:00:00.000Z",
        publishedBefore: "2026-10-30T23:59:59.999Z",
      },
    })

    expect(scope).toEqual({
      feedIds: ["feed-1"],
      publishedAfter: "2026-10-30T00:00:00.000Z",
      publishedBefore: "2026-10-30T23:59:59.999Z",
    })
  })

  test("keeps the selection when the period bounds are unusable", () => {
    expect(
      scopeFromContext({
        blocks,
        coverage: { publishedAfter: "not-a-date", publishedBefore: 42 },
      }),
    ).toEqual({ feedIds: ["feed-1"] })
  })

  test("scopes a period that arrived without a timeline block", () => {
    expect(
      scopeFromContext({
        blocks: [],
        coverage: { publishedAfter: "2026-10-30T00:00:00.000Z" },
      }),
    ).toEqual({ publishedAfter: "2026-10-30T00:00:00.000Z" })
  })
})

describe("withDefaultScope", () => {
  const panel = { feedIds: ["feed-1"] }

  test("applies the panel's feed to a scan the model left unscoped", async () => {
    const beginScan = vi.fn(async () => ({ ok: true as const, data: { scanId: "scan-1" } }))

    await withDefaultScope(handlers({ beginScan: beginScan as never }), panel).beginScan({})

    expect(beginScan).toHaveBeenCalledWith({ scope: { feedIds: ["feed-1"] } })
  })

  test("keeps the panel's feed when the model only narrows a period", async () => {
    const beginScan = vi.fn(async () => ({ ok: true as const, data: { scanId: "scan-1" } }))
    const since = "2026-10-29T00:00:00.000Z"

    await withDefaultScope(handlers({ beginScan: beginScan as never }), panel).beginScan({
      scope: { publishedAfter: since },
    })

    expect(beginScan).toHaveBeenCalledWith({
      scope: { feedIds: ["feed-1"], publishedAfter: since },
    })
  })

  test("lets the model's own narrowing take over", async () => {
    const beginScan = vi.fn(async () => ({ ok: true as const, data: { scanId: "scan-1" } }))

    await withDefaultScope(handlers({ beginScan: beginScan as never }), panel).beginScan({
      scope: { views: [3] },
    })

    expect(beginScan).toHaveBeenCalledWith({ scope: { views: [3] } })
  })

  test("keeps an explicit empty feed list as the whole account", async () => {
    const beginScan = vi.fn(async () => ({ ok: true as const, data: { scanId: "scan-1" } }))

    await withDefaultScope(handlers({ beginScan: beginScan as never }), panel).beginScan({
      scope: { feedIds: [] },
    })

    expect(beginScan).toHaveBeenCalledWith({ scope: { feedIds: [] } })
  })

  test.each([{ feedIds: [] }, { views: [3] }, { inboxIds: ["inbox-1"] }])(
    "keeps the period when the source changes to %j",
    async (source) => {
      const beginScan = vi.fn(async () => ({ ok: true as const, data: { scanId: "scan-1" } }))
      const period = {
        publishedAfter: "2026-10-30T00:00:00.000Z",
        publishedBefore: "2026-10-30T23:59:59.999Z",
      }

      await withDefaultScope(handlers({ beginScan: beginScan as never }), {
        ...panel,
        ...period,
      }).beginScan({ scope: source })

      expect(beginScan).toHaveBeenCalledWith({ scope: { ...period, ...source } })
    },
  )

  test("lets explicit time bounds replace the defaults independently of the source", async () => {
    const beginScan = vi.fn(async () => ({ ok: true as const, data: { scanId: "scan-1" } }))
    const publishedBefore = "2026-10-30T23:59:59.999Z"
    const publishedAfter = "2026-10-29T00:00:00.000Z"

    await withDefaultScope(handlers({ beginScan: beginScan as never }), {
      ...panel,
      publishedAfter: "2026-10-30T00:00:00.000Z",
      publishedBefore,
    }).beginScan({ scope: { feedIds: [], publishedAfter } })

    expect(beginScan).toHaveBeenCalledWith({
      scope: { feedIds: [], publishedAfter, publishedBefore },
    })
  })

  test("leaves the handlers alone when the panel names no timeline", () => {
    const value = handlers()

    expect(withDefaultScope(value, undefined)).toBe(value)
  })
})
