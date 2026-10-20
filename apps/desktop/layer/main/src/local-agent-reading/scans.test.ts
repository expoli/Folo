import { describe, expect, test } from "vitest"

import { LocalAgentReadingScans, toScanSummary } from "./scans"
import { candidateEntry, createSyntheticProvider, enumerationPage } from "./test-doubles"

const scansWith = (
  provider: ReturnType<typeof createSyntheticProvider>["provider"],
  options: { now?: () => number; limits?: Parameters<typeof buildLimits>[0] } = {},
) =>
  new LocalAgentReadingScans({
    provider,
    ...(options.now ? { now: options.now } : {}),
    limits: buildLimits(options.limits),
  })

const buildLimits = (
  overrides: Partial<{
    maxScans: number
    maxEntriesPerScan: number
    enumerationPageSize: number
    enumerationBudgetMs: number
    scanTtlMs: number
    maxListLimit: number
  }> = {},
) => ({
  maxScans: 4,
  maxEntriesPerScan: 10,
  enumerationPageSize: 5,
  enumerationBudgetMs: 5_000,
  scanTtlMs: 60_000,
  maxListLimit: 100,
  ...overrides,
})

describe("scan enumeration", () => {
  test("pages through the account, de-duplicates by entry id and pins the list", async () => {
    const { provider, calls } = createSyntheticProvider({
      async enumerateUnread(request) {
        if (!request.cursor) {
          return enumerationPage({
            accountId: request.accountId,
            entries: [candidateEntry({ id: "a" }), candidateEntry({ id: "b" })],
            cursor: "page-2",
            sources: [
              {
                kind: "view",
                id: "0",
                label: "Articles",
                status: "partial",
                observedCount: 2,
                error: null,
              },
            ],
          })
        }

        return enumerationPage({
          accountId: request.accountId,
          // "b" again: the same entry can appear in two sources and must be served once.
          entries: [candidateEntry({ id: "b" }), candidateEntry({ id: "c" })],
          cursor: null,
          sources: [
            {
              kind: "view",
              id: "0",
              label: "Articles",
              status: "complete",
              observedCount: 3,
              error: null,
            },
          ],
        })
      },
    })

    const scans = scansWith(provider)
    const result = await scans.begin({ accountId: "acct-1", scope: {} })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(calls.enumerate).toHaveLength(2)
    expect(calls.enumerate[0]).toMatchObject({ accountId: "acct-1", cursor: null, limit: 5 })
    expect(calls.enumerate[1]).toMatchObject({ cursor: "page-2" })

    expect(result.scan.candidates.map((entry) => entry.id)).toEqual(["a", "b", "c"])
    expect(result.scan.duplicatesRemoved).toBe(1)
    expect(result.scan.enumerationComplete).toBe(true)
    expect(result.scan.status).toBe("complete")
    expect(toScanSummary(result.scan)).toMatchObject({
      selectedCount: 3,
      selectionConsistency: "best_effort",
      duplicatesRemoved: 1,
    })
  })

  test("an unobserved read state is not unread", async () => {
    const { provider } = createSyntheticProvider({
      async enumerateUnread(request) {
        return enumerationPage({
          accountId: request.accountId,
          entries: [
            candidateEntry({ id: "unread" }),
            candidateEntry({ id: "unknown", readState: "unknown" }),
          ],
        })
      },
    })

    const result = await scansWith(provider).begin({ accountId: "acct-1", scope: {} })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.scan.candidates.map((entry) => entry.id)).toEqual(["unread"])
    expect(result.scan.unknownReadStateCount).toBe(1)
  })

  test("a source that could not be read makes the enumeration incomplete", async () => {
    const { provider } = createSyntheticProvider({
      async enumerateUnread(request) {
        return enumerationPage({
          accountId: request.accountId,
          entries: [candidateEntry({ id: "a" })],
          sources: [
            {
              kind: "view",
              id: "0",
              label: "Articles",
              status: "complete",
              observedCount: 1,
              error: null,
            },
            {
              kind: "inbox",
              id: "inbox-1",
              label: "Inbox",
              status: "failed",
              observedCount: 0,
              error: "boom",
            },
          ],
          errors: [{ source: "inbox-1", code: "UPSTREAM_ERROR", message: "boom" }],
        })
      },
    })

    const result = await scansWith(provider).begin({ accountId: "acct-1", scope: {} })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.scan.enumerationComplete).toBe(false)
    expect(result.scan.status).toBe("partial")
    expect(result.scan.errors).toEqual([
      { code: "source_failed", message: "inbox-1: boom", source: "inbox-1" },
    ])
  })

  test("a source that ends on an unverifiable page boundary keeps the scan incomplete", async () => {
    // What the renderer reports when a source's last page was full: the walk ended, but who shares
    // the cut publish time could not be observed, so the selection must not be called exhaustive.
    const { provider } = createSyntheticProvider({
      async enumerateUnread(request) {
        return enumerationPage({
          accountId: request.accountId,
          entries: [candidateEntry({ id: "a" })],
          sources: [
            {
              kind: "view",
              id: "0",
              label: "Articles",
              status: "partial",
              observedCount: 1,
              error: null,
            },
            {
              kind: "view",
              id: "1",
              label: "Social media",
              status: "complete",
              observedCount: 0,
              error: null,
            },
          ],
        })
      },
    })

    const result = await scansWith(provider).begin({ accountId: "acct-1", scope: {} })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.scan.enumerationComplete).toBe(false)
    expect(result.scan.status).toBe("partial")
    expect(result.scan.candidates.map((entry) => entry.id)).toEqual(["a"])
  })

  test("the candidate list is truncated explicitly, never silently", async () => {
    let page = 0
    const { provider } = createSyntheticProvider({
      async enumerateUnread(request) {
        page += 1
        return enumerationPage({
          accountId: request.accountId,
          entries: [
            candidateEntry({ id: `p${page}-a` }),
            candidateEntry({ id: `p${page}-b` }),
            candidateEntry({ id: `p${page}-c` }),
          ],
          cursor: `page-${page}`,
        })
      },
    })

    const scans = new LocalAgentReadingScans({
      provider,
      limits: buildLimits({ maxEntriesPerScan: 5 }),
    })
    const result = await scans.begin({ accountId: "acct-1", scope: {} })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Two pages held six entries; the fifth is the last one served, and the scan says why.
    expect(result.scan.candidates).toHaveLength(5)
    expect(result.scan.enumerationComplete).toBe(false)
    expect(result.scan.errors[0]).toMatchObject({ code: "scan_limit_reached" })
  })

  test("a scan that runs out of time reports why it stopped", async () => {
    let clock = 0
    const { provider } = createSyntheticProvider({
      async enumerateUnread(request) {
        clock += 4_000
        return enumerationPage({
          accountId: request.accountId,
          entries: [candidateEntry({ id: `e${clock}` })],
          cursor: `page-${clock}`,
        })
      },
    })

    const scans = new LocalAgentReadingScans({
      provider,
      now: () => clock,
      limits: buildLimits({ enumerationBudgetMs: 5_000, maxEntriesPerScan: 100 }),
    })
    const result = await scans.begin({ accountId: "acct-1", scope: {} })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.scan.enumerationComplete).toBe(false)
    expect(result.scan.errors[0]).toMatchObject({ code: "enumeration_budget_exhausted" })
  })

  test("a provider failure fails the scan instead of returning an empty list", async () => {
    const { provider } = createSyntheticProvider({
      async enumerateUnread() {
        return { ok: false, error: { code: "APP_NOT_READY", message: "window gone" } }
      },
    })

    const result = await scansWith(provider).begin({ accountId: "acct-1", scope: {} })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.scan.status).toBe("failed")
    expect(result.scan.candidates).toHaveLength(0)
    expect(result.scan.errors[0]).toMatchObject({ code: "provider_unavailable" })
  })

  test("an enumeration cursor that does not advance is refused", async () => {
    const { provider } = createSyntheticProvider({
      async enumerateUnread(request) {
        return enumerationPage({
          accountId: request.accountId,
          entries: [candidateEntry({ id: `e-${request.cursor ?? "start"}` })],
          cursor: "stuck",
        })
      },
    })

    const result = await scansWith(provider).begin({ accountId: "acct-1", scope: {} })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.scan.status).toBe("failed")
    expect(result.scan.errors[0]).toMatchObject({ code: "provider_unavailable" })
  })
})

describe("scan list", () => {
  const beginWith = async (count: number) => {
    const { provider } = createSyntheticProvider({
      async enumerateUnread(request) {
        return enumerationPage({
          accountId: request.accountId,
          entries: Array.from({ length: count }, (_, index) => candidateEntry({ id: `e${index}` })),
        })
      },
    })

    const scans = scansWith(provider)
    const begun = await scans.begin({ accountId: "acct-1", scope: {} })
    if (!begun.ok) throw new Error("scan did not start")

    return { scans, scanId: begun.scan.id }
  }

  test("pages through the fixed list and stops with the last entry", async () => {
    const { scans, scanId } = await beginWith(3)

    const first = scans.list({ scanId, accountId: "acct-1", limit: 2 })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.entries.map((entry) => entry.id)).toEqual(["e0", "e1"])
    expect(first.hasMore).toBe(true)
    expect(first.cursor).not.toBeNull()

    const second = scans.list({ scanId, accountId: "acct-1", limit: 2, cursor: first.cursor! })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.entries.map((entry) => entry.id)).toEqual(["e2"])
    expect(second.hasMore).toBe(false)
    expect(second.cursor).toBeNull()
  })

  test("an unknown cursor is a request error, not an empty page", async () => {
    const { scans, scanId } = await beginWith(2)
    const result = scans.list({ scanId, accountId: "acct-1", cursor: "nonsense" })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("INVALID_REQUEST")
  })

  test("an expired scan is refused with its own reason", async () => {
    let clock = 0
    const { provider } = createSyntheticProvider({
      async enumerateUnread(request) {
        return enumerationPage({
          accountId: request.accountId,
          entries: [candidateEntry({ id: "a" })],
        })
      },
    })
    const scans = new LocalAgentReadingScans({
      provider,
      now: () => clock,
      limits: buildLimits({ scanTtlMs: 1_000 }),
    })
    const begun = await scans.begin({ accountId: "acct-1", scope: {} })
    if (!begun.ok) throw new Error("scan did not start")

    clock = 5_000
    const result = scans.list({ scanId: begun.scan.id, accountId: "acct-1" })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("SCAN_EXPIRED")
  })

  test("a scan of another account cannot be read and is dropped", async () => {
    const { scans, scanId } = await beginWith(1)

    const other = scans.get({ scanId, accountId: "acct-2" })
    expect(other.ok).toBe(false)
    if (other.ok) return
    expect(other.error.code).toBe("SCAN_NOT_FOUND")

    // Dropped, so the original account cannot read it either: an account switch ends the scan.
    expect(scans.get({ scanId, accountId: "acct-1" }).ok).toBe(false)
  })

  test("the oldest scan is dropped when the limit is reached", async () => {
    const { provider } = createSyntheticProvider({
      async enumerateUnread(request) {
        return enumerationPage({
          accountId: request.accountId,
          entries: [candidateEntry({ id: "a" })],
        })
      },
    })
    const scans = new LocalAgentReadingScans({ provider, limits: buildLimits({ maxScans: 2 }) })

    const first = await scans.begin({ accountId: "acct-1", scope: {} })
    const second = await scans.begin({ accountId: "acct-1", scope: {} })
    const third = await scans.begin({ accountId: "acct-1", scope: {} })
    if (!first.ok || !second.ok || !third.ok) throw new Error("scan did not start")

    expect(scans.activeCount).toBe(2)
    expect(scans.get({ scanId: first.scan.id, accountId: "acct-1" }).ok).toBe(false)
    expect(scans.get({ scanId: third.scan.id, accountId: "acct-1" }).ok).toBe(true)
  })

  test("clearing forgets every scan", async () => {
    const { scans, scanId } = await beginWith(1)
    expect(scans.clear()).toBe(1)
    expect(scans.get({ scanId, accountId: "acct-1" }).ok).toBe(false)
  })
})
