/**
 * Enumeration of a scan's candidates.
 *
 * The account API is faked: these tests are about the rules the renderer promises the main process,
 * not about HTTP. In particular they pin the cases that decide whether an agent may call its
 * summary complete: more than one page, entries the user never opened, equal publish times, a
 * source that fails, an unobservable read state, and a page that does not advance.
 */
import type {
  LocalAgentReadingEnumerationPage,
  LocalAgentReadingEnumerationRequest,
} from "@follow/shared/local-agent-reading"
import { FollowAPIError } from "@follow-app/client-sdk"
import { describe, expect, it } from "vitest"

import { enumerateUnreadPage } from "./enumerate"
import type { ListSourcePageInput, LocalAgentReadingDeps, SourcePageItem } from "./types"

const ACCOUNT = "account-1"
const NOW = Date.parse("2026-10-20T10:00:00.000Z")

const candidate = (
  id: string,
  publishedAt: string,
  extra: Partial<SourcePageItem> = {},
): SourcePageItem => ({
  id,
  title: `Title ${id}`,
  url: `https://example.com/${id}`,
  feedId: "feed-1",
  publishedAt,
  read: false,
  ...extra,
})

const pageOf = (page: LocalAgentReadingEnumerationPage) => {
  if (!page.ok) throw new Error(`expected a page, got ${page.error.code}: ${page.error.message}`)
  return page
}

const failureOf = (page: LocalAgentReadingEnumerationPage) => {
  if (page.ok) throw new Error("expected a refusal")
  return page
}

/**
 * Pages are consumed in the order they are listed, per `kind:id`; an exhausted source answers an
 * empty page, exactly like the end of a real pagination.
 */
const createDeps = (
  pages: Record<string, SourcePageItem[][]>,
  overrides: Partial<LocalAgentReadingDeps> = {},
) => {
  const calls: ListSourcePageInput[] = []
  const deps: LocalAgentReadingDeps = {
    getAccountId: () => ACCOUNT,
    listInboxIds: () => [],
    getSourceLabel: () => null,
    listSourcePage: async (input) => {
      calls.push(input)
      const queue = pages[`${input.source.kind}:${input.source.id}`] ?? []
      const next = queue.shift() ?? []
      // The account honors `limit`: it never answers more rows than it was asked for.
      return next.slice(0, input.limit)
    },
    getReadOverlay: () => null,
    getStoredEntries: async () => [],
    loadEntryDetail: async () => null,
    loadEntryReadability: async () => null,
    now: () => NOW,
    ...overrides,
  }
  return { deps, calls }
}

const request = (
  overrides: Partial<LocalAgentReadingEnumerationRequest> = {},
): LocalAgentReadingEnumerationRequest => ({
  requestId: "request-1",
  accountId: ACCOUNT,
  scope: {},
  cursor: null,
  limit: 3,
  ...overrides,
})

describe("enumerateUnreadPage", () => {
  it("walks every page of the account and ends with an empty cursor", async () => {
    const { deps, calls } = createDeps({
      "view:0": [
        [
          candidate("a", "2026-10-20T09:00:00.000Z"),
          candidate("b", "2026-10-20T08:00:00.000Z"),
          candidate("c", "2026-10-20T07:00:00.000Z"),
        ],
        [candidate("d", "2026-10-20T06:00:00.000Z")],
      ],
      // Entries the user never opened: nothing about them is cached locally.
    })
    const first = pageOf(await enumerateUnreadPage(deps, request()))

    expect(first.entries.map((entry) => entry.id)).toEqual(["a", "b", "c"])
    // The page was full, so its cut is a boundary whose coverage cannot be verified.
    expect(first.errors.map((error) => error.code)).toEqual(["page_boundary_unverified"])
    expect(first.cursor).not.toBeNull()
    // Every supported view is walked, and only view 0 had anything.
    expect(first.sources.map((source) => `${source.kind}:${source.id}`)).toEqual([
      "view:0",
      "view:1",
      "view:2",
      "view:3",
      "view:4",
    ])

    const second = pageOf(await enumerateUnreadPage(deps, request({ cursor: first.cursor })))
    expect(second.entries.map((entry) => entry.id)).toEqual(["d"])
    expect(second.cursor).toBeNull()
    // The first page was full, so where it was cut cannot be verified: the source keeps saying so
    // even though the walk reached its end. A source that never filled a page stays complete.
    expect(second.sources[0]).toMatchObject({ status: "partial", observedCount: 4 })
    expect(second.sources.slice(1).every((source) => source.status === "complete")).toBe(true)
    expect(second.errors).toEqual([])

    // Newest first, one page at a time, and the last view answered once more than it had to.
    expect(calls[0]).toMatchObject({ source: { kind: "view", id: "0" }, cursor: null, limit: 3 })
    expect(calls[1]).toMatchObject({
      source: { kind: "view", id: "0" },
      cursor: "2026-10-20T07:00:00.000Z",
    })
  })

  it("reports an entry whose read state cannot be observed as unknown and never as unread", async () => {
    const { deps } = createDeps({
      "view:0": [
        [
          candidate("unread", "2026-10-20T09:00:00.000Z", { read: false }),
          candidate("unknown", "2026-10-20T08:00:00.000Z", { read: null }),
          candidate("read", "2026-10-20T07:00:00.000Z", { read: true }),
        ],
      ],
    })

    const page = pageOf(await enumerateUnreadPage(deps, request({ limit: 10 })))
    const byId = new Map(page.entries.map((entry) => [entry.id, entry]))

    expect(byId.get("unread")?.readState).toBe("unread")
    expect(byId.get("unknown")?.readState).toBe("unknown")
    // A known read entry is not a candidate at all.
    expect(byId.has("read")).toBe(false)
    expect(
      page.entries.every((entry) => entry.readStateObservedAt === "2026-10-20T10:00:00.000Z"),
    ).toBe(true)
  })

  it("lets a pending local read change win over the account snapshot", async () => {
    const overlays = new Map<string, boolean>([
      ["marked-read", true],
      ["marked-unread", false],
    ])
    const { deps } = createDeps(
      {
        "view:0": [
          [
            candidate("marked-read", "2026-10-20T09:00:00.000Z", { read: false }),
            // The server has not caught up with a local "mark unread" yet.
            candidate("marked-unread", "2026-10-20T08:00:00.000Z", { read: true }),
          ],
        ],
      },
      { getReadOverlay: (entryId) => overlays.get(entryId) ?? null },
    )

    const page = pageOf(await enumerateUnreadPage(deps, request({ limit: 10 })))
    expect(page.entries.map((entry) => entry.id)).toEqual(["marked-unread"])
  })

  it("reports a failing source instead of an empty one", async () => {
    const { deps } = createDeps(
      { "view:1": [[candidate("from-view-1", "2026-10-20T08:00:00.000Z")]] },
      {
        listSourcePage: async (input) => {
          if (input.source.id === "0") throw new Error("account API is down")
          const queue = { "view:1": [[candidate("from-view-1", "2026-10-20T08:00:00.000Z")]] }
          const next = queue[`${input.source.kind}:${input.source.id}`]?.shift() ?? []
          return next.slice(0, input.limit)
        },
      },
    )

    const page = pageOf(await enumerateUnreadPage(deps, request()))
    expect(page.entries.map((entry) => entry.id)).toEqual(["from-view-1"])
    expect(page.sources[0]).toMatchObject({ kind: "view", id: "0", status: "failed" })
    expect(page.errors).toEqual([
      { source: "view:0", code: "source_failed", message: "The account API request failed" },
    ])
  })

  it("never echoes the account client's error text to the agent", async () => {
    // The account client puts the request headers, cookie included, into its message.
    const leaked = new FollowAPIError(
      'Request failed\nArgs: { "headers": { "Cookie": "better-auth.session_token=secret" } }',
      500,
    )
    const { deps } = createDeps(
      {},
      {
        listSourcePage: async (input) => {
          if (input.source.id === "0") throw leaked
          return []
        },
      },
    )

    const page = pageOf(await enumerateUnreadPage(deps, request()))
    const message = page.errors[0]?.message ?? ""
    expect(message).toBe("The account API answered HTTP 500")
    expect(message.toLowerCase()).not.toContain("cookie")
    expect(message).not.toContain("secret")
  })

  it("does not report an empty account as a failure", async () => {
    const { deps } = createDeps({})
    const page = pageOf(await enumerateUnreadPage(deps, request()))

    expect(page.entries).toEqual([])
    expect(page.errors).toEqual([])
    expect(page.cursor).toBeNull()
    expect(page.sources.every((source) => source.status === "complete")).toBe(true)
  })

  it("stops a source whose page does not move past the previous one", async () => {
    const tie = "2026-10-20T09:00:00.000Z"
    const { deps } = createDeps({
      "view:0": [
        [candidate("a", tie), candidate("b", tie), candidate("c", tie)],
        // The account answered the same page again instead of moving on.
        [candidate("a", tie), candidate("b", tie), candidate("c", tie)],
      ],
    })

    const first = pageOf(await enumerateUnreadPage(deps, request({ limit: 3 })))
    const second = pageOf(
      await enumerateUnreadPage(deps, request({ limit: 3, cursor: first.cursor })),
    )

    expect(second.sources[0]).toMatchObject({ kind: "view", id: "0", status: "failed" })
    expect(second.errors.map((error) => error.code)).toEqual(["cursor_not_advancing"])
    // The walk goes on with the next source instead of looping on this one, and it does end.
    const third = pageOf(
      await enumerateUnreadPage(deps, request({ limit: 3, cursor: second.cursor })),
    )
    expect(third.cursor).toBeNull()
    expect(third.sources.map((source) => source.status)).toEqual([
      "failed",
      "complete",
      "complete",
      "complete",
      "complete",
    ])
  })

  it("discloses a page boundary that falls inside equal publish times", async () => {
    const tie = "2026-10-20T09:00:00.000Z"
    const { deps } = createDeps({
      "view:0": [
        [candidate("a", "2026-10-20T09:30:00.000Z"), candidate("b", tie), candidate("c", tie)],
        [candidate("d", "2026-10-20T08:00:00.000Z")],
      ],
    })

    const first = pageOf(await enumerateUnreadPage(deps, request({ limit: 3 })))
    expect(first.errors.map((error) => error.code)).toContain("timestamp_tie_boundary")

    const second = pageOf(
      await enumerateUnreadPage(deps, request({ limit: 3, cursor: first.cursor })),
    )
    expect(second.sources[0]!.status).toBe("partial")
    expect(second.sources[0]!.observedCount).toBe(4)
  })

  it("does not claim coverage of a cut timestamp whose siblings the cursor never returns", async () => {
    const cut = "2026-10-20T09:00:00.000Z"
    const rows = [
      candidate("a", "2026-10-20T09:30:00.000Z"),
      candidate("b", cut),
      // A second entry published at exactly the cut time: a next cursor that is exclusive of that
      // time never returns it, and nothing in the page itself shows it exists.
      candidate("hidden", cut),
      candidate("c", "2026-10-20T08:00:00.000Z"),
    ]
    const { deps } = createDeps(
      {},
      {
        listSourcePage: async (input) => {
          if (input.source.kind !== "view" || input.source.id !== "0") return []
          const after = input.cursor === null ? null : Date.parse(input.cursor)
          const eligible =
            after === null ? rows : rows.filter((row) => Date.parse(row.publishedAt!) < after)
          return eligible.slice(0, input.limit)
        },
      },
    )

    const first = pageOf(await enumerateUnreadPage(deps, request({ limit: 2 })))
    // The tie starts exactly at the last row, so the page alone cannot show the blind spot.
    expect(first.entries.map((entry) => entry.id)).toEqual(["a", "b"])
    expect(first.errors.map((error) => error.code)).toEqual(["page_boundary_unverified"])

    const second = pageOf(
      await enumerateUnreadPage(deps, request({ limit: 2, cursor: first.cursor })),
    )
    // "hidden" was silently skipped, so the source must not present itself as complete.
    expect(second.entries.map((entry) => entry.id)).toEqual(["c"])
    expect(second.cursor).toBeNull()
    expect(second.sources[0]!.status).toBe("partial")
  })

  it("never asks for more rows than a page holds, nor reads that answer as the end", async () => {
    const rows = Array.from({ length: 150 }, (_, index) =>
      candidate(
        `e${index}`,
        new Date(Date.parse("2026-10-20T09:00:00.000Z") - index * 60_000).toISOString(),
      ),
    )
    const { deps, calls } = createDeps(
      {},
      {
        listSourcePage: async (input) => {
          calls.push(input)
          if (input.source.kind !== "view" || input.source.id !== "0") return []
          const after = input.cursor === null ? null : Date.parse(input.cursor)
          const eligible =
            after === null ? rows : rows.filter((row) => Date.parse(row.publishedAt!) < after)
          // The account answers at most 100 rows per page, however many were asked for.
          return eligible.slice(0, Math.min(input.limit, 100))
        },
      },
    )

    const first = pageOf(await enumerateUnreadPage(deps, request({ limit: 500 })))
    // The request is clamped to the API's page cap, and the short answer is not taken as the end.
    expect(calls[0]!.limit).toBe(100)
    expect(first.entries).toHaveLength(100)
    expect(first.cursor).not.toBeNull()

    const second = pageOf(
      await enumerateUnreadPage(deps, request({ limit: 500, cursor: first.cursor })),
    )
    expect(second.entries.map((entry) => entry.id)).toEqual(rows.slice(100).map((row) => row.id))
    expect(second.cursor).toBeNull()
  })

  it("narrows the plan to the feeds or views the agent named", async () => {
    const { deps: feedDeps, calls: feedCalls } = createDeps({
      "feed:feed-9": [[candidate("x", "2026-10-20T09:00:00.000Z")]],
    })
    const feedPage = pageOf(
      await enumerateUnreadPage(feedDeps, request({ scope: { feedIds: ["feed-9"] } })),
    )
    expect(feedPage.sources.map((source) => `${source.kind}:${source.id}`)).toEqual(["feed:feed-9"])
    expect(feedCalls[0]!.source).toEqual({ kind: "feed", id: "feed-9" })

    const { deps: viewDeps, calls: viewCalls } = createDeps({})
    const viewPage = pageOf(
      await enumerateUnreadPage(viewDeps, request({ scope: { views: [-1] } })),
    )
    expect(viewPage.sources).toHaveLength(5)
    expect(viewCalls.map((call) => call.source.id)).toEqual(["0", "1", "2", "3", "4"])

    // Repeating an id never pages the same source twice.
    const { deps: repeated } = createDeps({})
    const repeatedPage = pageOf(
      await enumerateUnreadPage(repeated, request({ scope: { feedIds: ["feed-9", "feed-9"] } })),
    )
    expect(repeatedPage.sources).toHaveLength(1)
  })

  it("lists the inboxes of the account unless the scope names some", async () => {
    const { deps, calls } = createDeps({}, { listInboxIds: () => ["inbox-a", "inbox-b"] })
    const first = pageOf(await enumerateUnreadPage(deps, request()))
    expect(
      first.sources.filter((source) => source.kind === "inbox").map((source) => source.id),
    ).toEqual(["inbox-a", "inbox-b"])
    // The page stops between sources, so the second inbox is walked by the next page.
    expect(first.cursor).not.toBeNull()
    const second = pageOf(await enumerateUnreadPage(deps, request({ cursor: first.cursor })))
    expect(second.cursor).toBeNull()
    expect(
      second.sources.filter((source) => source.kind === "inbox").map((source) => source.status),
    ).toEqual(["complete", "complete"])
    const inboxCalls = calls.filter((call) => call.source.kind === "inbox")
    expect(inboxCalls.map((call) => call.source.id)).toEqual(["inbox-a", "inbox-b"])

    const { deps: narrowed, calls: narrowedCalls } = createDeps(
      {},
      { listInboxIds: () => ["inbox-a", "inbox-b"] },
    )
    const narrowedPage = pageOf(
      await enumerateUnreadPage(narrowed, request({ scope: { views: [0] } })),
    )
    expect(narrowedPage.sources.some((source) => source.kind === "inbox")).toBe(false)
    expect(narrowedCalls.every((call) => call.source.kind === "view")).toBe(true)
  })

  it("reports a view this build does not know as unsupported", async () => {
    const { deps, calls } = createDeps({})
    const page = pageOf(await enumerateUnreadPage(deps, request({ scope: { views: [4, 5] } })))

    expect(page.sources.map((source) => `${source.id}:${source.status}`)).toEqual([
      "4:complete",
      "5:unsupported",
    ])
    expect(page.errors).toEqual([
      {
        source: "view:5",
        code: "source_unsupported",
        message: "This build cannot enumerate view:5",
      },
    ])
    expect(calls.every((call) => call.source.id !== "5")).toBe(true)
  })

  it("applies a scope time range itself and stops below the lower bound", async () => {
    const { deps } = createDeps({
      "view:0": [
        [
          candidate("too-new", "2026-10-20T09:59:00.000Z"),
          candidate("in-range", "2026-10-20T08:00:00.000Z"),
          candidate("too-old", "2026-10-19T08:00:00.000Z"),
        ],
        [candidate("unreached", "2026-10-18T08:00:00.000Z")],
      ],
    })

    const page = pageOf(
      await enumerateUnreadPage(
        deps,
        request({
          limit: 5,
          scope: {
            publishedAfter: "2026-10-20T00:00:00.000Z",
            publishedBefore: "2026-10-20T09:00:00.000Z",
          },
        }),
      ),
    )

    // The newest entry is above the range and the oldest is below it; going below it ends the
    // source, so the page after it is never requested.
    expect(page.entries.map((entry) => entry.id)).toEqual(["in-range"])
    expect(page.sources[0]!.status).toBe("complete")
    expect(page.cursor).toBeNull()
  })

  it("marks candidates whose text is already stored", async () => {
    const { deps } = createDeps(
      {
        "view:0": [
          [
            candidate("cached", "2026-10-20T09:00:00.000Z"),
            candidate("uncached", "2026-10-20T08:00:00.000Z"),
          ],
        ],
      },
      {
        getStoredEntries: async (entryIds) => [
          {
            id: entryIds[0]!,
            inboxHandle: null,
            content: "feed text",
            readabilityContent: null,
            readabilityUpdatedAt: null,
            description: null,
          },
        ],
      },
    )

    const page = pageOf(await enumerateUnreadPage(deps, request({ limit: 10 })))
    expect(page.entries.map((entry) => entry.hasCachedContent)).toEqual([true, false])
  })

  it("refuses a cursor it did not issue", async () => {
    const { deps } = createDeps({})
    const page = failureOf(await enumerateUnreadPage(deps, request({ cursor: "not-a-cursor" })))
    expect(page.error.code).toBe("INVALID_REQUEST")
    expect(page.accountId).toBe(ACCOUNT)

    // A cursor with our prefix but a payload this version cannot read is refused as well.
    const foreign = failureOf(
      await enumerateUnreadPage(
        deps,
        request({ cursor: `r1.${encodeURIComponent(JSON.stringify({ sources: "nope" }))}` }),
      ),
    )
    expect(foreign.error.code).toBe("INVALID_REQUEST")
  })

  it("refuses to serve anything while the app has no session", async () => {
    const { deps } = createDeps({}, { getAccountId: () => null })
    const page = failureOf(await enumerateUnreadPage(deps, request()))
    expect(page.error.code).toBe("APP_NOT_READY")
  })

  it("refuses a scan belonging to another account", async () => {
    const { deps } = createDeps({})
    const page = failureOf(await enumerateUnreadPage(deps, request({ accountId: "account-2" })))
    expect(page.error.code).toBe("ACCOUNT_MISMATCH")
    expect(page.accountId).toBe(ACCOUNT)
  })

  it("drops the page when the account changes while it is being built", async () => {
    let currentAccount = ACCOUNT
    const { deps } = createDeps(
      { "view:0": [[candidate("a", "2026-10-20T09:00:00.000Z")]] },
      {
        getAccountId: () => currentAccount,
        listSourcePage: async () => {
          currentAccount = "account-2"
          return [candidate("a", "2026-10-20T09:00:00.000Z")]
        },
      },
    )

    const page = failureOf(await enumerateUnreadPage(deps, request()))
    expect(page.error.code).toBe("ACCOUNT_MISMATCH")
    expect(page.accountId).toBe("account-2")
  })

  it("stops at the caller's cancellation instead of serving a half page", async () => {
    const controller = new AbortController()
    const { deps } = createDeps(
      { "view:0": [[candidate("a", "2026-10-20T09:00:00.000Z")]] },
      {
        listSourcePage: async () => {
          controller.abort()
          throw new DOMException("cancelled", "AbortError")
        },
      },
    )

    const page = failureOf(await enumerateUnreadPage(deps, request(), controller.signal))
    expect(page.error.code).toBe("CANCELLED")
  })
})
