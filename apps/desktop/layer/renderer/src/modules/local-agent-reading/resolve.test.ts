/**
 * Text of the entries of a scan.
 *
 * What these tests protect: the source of a text is always named, an excerpt is never called the
 * whole article, one unreadable entry does not cost the batch, and the detail API is only used when
 * the caller asked for it.
 */
import type { LocalAgentReadingEntriesRequest } from "@follow/shared/local-agent-reading"
import { FollowAPIError } from "@follow-app/client-sdk"
import { describe, expect, it } from "vitest"

import { resolveEntryContents } from "./resolve"
import type { LocalAgentReadingDeps, StoredEntryText } from "./types"

const ACCOUNT = "account-1"
const NOW = Date.parse("2026-10-20T10:00:00.000Z")

const request = (
  overrides: Partial<LocalAgentReadingEntriesRequest> = {},
): LocalAgentReadingEntriesRequest => ({
  requestId: "request-1",
  accountId: ACCOUNT,
  entryIds: ["entry-1"],
  includeDetail: false,
  ...overrides,
})

const storedRow = (overrides: Partial<StoredEntryText> & { id: string }): StoredEntryText => ({
  inboxHandle: null,
  content: null,
  readabilityContent: null,
  readabilityUpdatedAt: null,
  description: null,
  ...overrides,
})

const createDeps = (
  options: {
    stored?: StoredEntryText[]
    detail?: Record<string, string | Error | null>
    readability?: Record<string, string | Error | null>
    overrides?: Partial<LocalAgentReadingDeps>
  } = {},
) => {
  const calls: string[] = []
  const deps: LocalAgentReadingDeps = {
    getAccountId: () => ACCOUNT,
    listInboxIds: () => [],
    getSourceLabel: () => null,
    listSourcePage: async () => [],
    getReadOverlay: () => null,
    getStoredEntries: async (entryIds) =>
      (options.stored ?? []).filter((row) => entryIds.includes(row.id)),
    loadEntryDetail: async (entryId) => {
      calls.push(`detail:${entryId}`)
      const answer = options.detail?.[entryId]
      if (answer instanceof Error) throw answer
      return answer ?? null
    },
    loadEntryReadability: async (entryId) => {
      calls.push(`readability:${entryId}`)
      const answer = options.readability?.[entryId]
      if (answer instanceof Error) throw answer
      return answer ?? null
    },
    now: () => NOW,
    ...options.overrides,
  }
  return { deps, calls }
}

const resultOf = (page: Awaited<ReturnType<typeof resolveEntryContents>>) => {
  if (!page.ok) throw new Error(`expected entries, got ${page.error.code}: ${page.error.message}`)
  return page
}

describe("resolveEntryContents", () => {
  it("serves the stored reader text before the feed content and never claims it is whole", async () => {
    const { deps, calls } = createDeps({
      stored: [
        storedRow({
          id: "entry-1",
          content: "<p>feed excerpt</p>",
          readabilityContent: "<p>reader text</p>",
          readabilityUpdatedAt: "2026-10-19T08:00:00.000Z",
        }),
      ],
    })

    const result = resultOf(await resolveEntryContents(deps, request({ includeDetail: true })))
    expect(result.entries[0]).toEqual({
      entryId: "entry-1",
      title: null,
      content: "<p>reader text</p>",
      contentFormat: "html",
      contentSource: "readability",
      completeness: "unknown",
      fetchedAt: "2026-10-19T08:00:00.000Z",
      error: null,
    })
    // Stored text is enough: the account is not asked again.
    expect(calls).toEqual([])
  })

  it("names the feed content as rss and the description as a partial text", async () => {
    const { deps } = createDeps({
      stored: [
        storedRow({ id: "entry-1", content: "<p>feed excerpt</p>" }),
        storedRow({ id: "entry-2", description: "A short summary" }),
      ],
    })

    const result = resultOf(
      await resolveEntryContents(deps, request({ entryIds: ["entry-1", "entry-2"] })),
    )
    expect(result.entries.map((entry) => [entry.contentSource, entry.completeness])).toEqual([
      ["rss", "unknown"],
      ["description", "partial"],
    ])
  })

  it("says there is no text in cached mode instead of silently reading the account", async () => {
    const { deps, calls } = createDeps({ detail: { "entry-1": "<p>detail</p>" } })

    const result = resultOf(await resolveEntryContents(deps, request()))
    expect(result.entries[0]!.error).toEqual({
      code: "no_content",
      message: "No text is stored for this entry; read it in the detail or source_page mode",
    })
    expect(calls).toEqual([])
  })

  it("reads a never-loaded entry through the detail API when the caller allows it", async () => {
    const { deps, calls } = createDeps({ detail: { "entry-1": "<p>detail</p>" } })

    const result = resultOf(await resolveEntryContents(deps, request({ includeDetail: true })))
    expect(result.entries[0]).toMatchObject({
      content: "<p>detail</p>",
      contentSource: "rss",
      completeness: "unknown",
      error: null,
    })
    expect(calls).toEqual(["detail:entry-1"])
  })

  it("falls back to the account's extracted text when the detail answer has none", async () => {
    const { deps, calls } = createDeps({ readability: { "entry-1": "<p>reader</p>" } })

    const result = resultOf(await resolveEntryContents(deps, request({ includeDetail: true })))
    expect(result.entries[0]).toMatchObject({
      content: "<p>reader</p>",
      contentSource: "readability",
    })
    expect(calls).toEqual(["detail:entry-1", "readability:entry-1"])
  })

  it("keeps the batch when one entry cannot be read at all", async () => {
    const { deps } = createDeps({
      stored: [storedRow({ id: "entry-2", content: "<p>feed</p>" })],
      detail: { "entry-1": new Error("upstream failed") },
      readability: { "entry-1": new Error("upstream failed") },
    })

    const result = resultOf(
      await resolveEntryContents(
        deps,
        request({ entryIds: ["entry-1", "entry-2"], includeDetail: true }),
      ),
    )
    expect(result.entries).toHaveLength(2)
    expect(result.entries[0]!.error).toEqual({
      code: "unavailable",
      message: "The account API request failed",
    })
    expect(result.entries[1]!.contentSource).toBe("rss")
  })

  it("never echoes the account client's error text to the agent", async () => {
    const leaked = new FollowAPIError(
      'Request failed\nArgs: { "headers": { "Cookie": "better-auth.session_token=secret" } }',
      403,
    )
    const { deps } = createDeps({
      detail: { "entry-1": leaked },
      readability: { "entry-1": leaked },
    })

    const result = resultOf(await resolveEntryContents(deps, request({ includeDetail: true })))
    const message = result.entries[0]!.error?.message ?? ""
    expect(message).toBe("The account API answered HTTP 403")
    expect(message.toLowerCase()).not.toContain("cookie")
    expect(message).not.toContain("secret")
  })

  it("reports an entry the account knows nothing about", async () => {
    const { deps } = createDeps({})
    const result = resultOf(await resolveEntryContents(deps, request({ includeDetail: true })))
    expect(result.entries[0]!.error?.code).toBe("no_content")
  })

  it("asks once per entry, in the order it was given, and drops repeats", async () => {
    const { deps, calls } = createDeps({
      stored: [
        storedRow({ id: "a", content: "<p>a</p>" }),
        storedRow({ id: "b", content: "<p>b</p>" }),
      ],
    })

    const result = resultOf(
      await resolveEntryContents(deps, request({ entryIds: ["b", "a", "b"] })),
    )
    expect(result.entries.map((entry) => entry.entryId)).toEqual(["b", "a"])
    expect(calls).toEqual([])
  })

  it("refuses entries of another account and while signed out", async () => {
    const { deps } = createDeps({})
    const mismatch = await resolveEntryContents(deps, request({ accountId: "account-2" }))
    expect(mismatch.ok).toBe(false)
    if (!mismatch.ok) expect(mismatch.error.code).toBe("ACCOUNT_MISMATCH")

    const { deps: signedOut } = createDeps({ overrides: { getAccountId: () => null } })
    const nowhere = await resolveEntryContents(signedOut, request())
    expect(nowhere.ok).toBe(false)
    if (!nowhere.ok) expect(nowhere.error.code).toBe("APP_NOT_READY")
  })

  it("drops the answer when the account changes while it is being read", async () => {
    let current = ACCOUNT
    const { deps } = createDeps({
      overrides: {
        getAccountId: () => current,
        getStoredEntries: async () => {
          current = "account-2"
          return [storedRow({ id: "entry-1", content: "<p>feed</p>" })]
        },
      },
    })

    const result = await resolveEntryContents(deps, request())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("ACCOUNT_MISMATCH")
      expect(result.accountId).toBe("account-2")
    }
  })

  it("stops on cancellation before asking for text", async () => {
    const controller = new AbortController()
    controller.abort()
    const { deps, calls } = createDeps({ detail: { "entry-1": "<p>detail</p>" } })

    const result = await resolveEntryContents(
      deps,
      request({ includeDetail: true }),
      controller.signal,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("CANCELLED")
    expect(calls).toEqual([])
  })
})
