/**
 * Scans: the fixed candidate list the endpoint talks about.
 *
 * A scan enumerates the unread entries of one account once, de-duplicates them by entry id, and
 * keeps that list. Pagination of the endpoint therefore reads a list that no longer moves when the
 * user reads something in the app — an agent that reports "3 of 40" and then "40 of 40" is talking
 * about the same 40 entries.
 *
 * Two kinds of completeness are kept apart and reported separately:
 * - the enumeration finishes only when every supported source reached the end of its pagination;
 * - the selection is still `best_effort`, because the account API offers no snapshot, so an entry
 *   that was marked read while the pages were being walked may be in the list or not.
 */
import { randomUUID } from "node:crypto"

import type {
  LocalAgentReadingCandidateEntry,
  LocalAgentReadingScanError,
  LocalAgentReadingScanStatus,
  LocalAgentReadingScanSummary,
  LocalAgentReadingScope,
  LocalAgentReadingSourceProgress,
} from "@follow/shared/local-agent-reading"
import { LOCAL_AGENT_READING_LIMITS } from "@follow/shared/local-agent-reading"

import type { LocalAgentReadingDataProvider } from "./provider"

export type ScanFailureCode = "SCAN_NOT_FOUND" | "SCAN_EXPIRED" | "PROVIDER_UNAVAILABLE"

export interface ScanFailure {
  ok: false
  error: { code: ScanFailureCode | "INVALID_REQUEST"; message: string }
}

export interface ScanRecord {
  id: string
  accountId: string
  scope: LocalAgentReadingScope
  startedAt: string
  finishedAt: string | null
  expiresAt: number
  status: LocalAgentReadingScanStatus
  enumerationComplete: boolean
  candidates: LocalAgentReadingCandidateEntry[]
  duplicatesRemoved: number
  unknownReadStateCount: number
  sources: LocalAgentReadingSourceProgress[]
  errors: LocalAgentReadingScanError[]
}

export interface BeginScanParams {
  accountId: string
  scope: LocalAgentReadingScope
  signal?: AbortSignal
}

export type BeginScanOutcome = { ok: true; scan: ScanRecord } | ScanFailure

export interface ListScanParams {
  scanId: string
  accountId: string
  /** Opaque cursor returned by the previous page. */
  cursor?: string
  limit?: number
}

export type ListScanOutcome =
  | {
      ok: true
      scan: ScanRecord
      entries: LocalAgentReadingCandidateEntry[]
      cursor: string | null
      hasMore: boolean
    }
  | ScanFailure

export interface ScansOptions {
  provider: LocalAgentReadingDataProvider
  now?: () => number
  log?: (line: string) => void
  limits?: {
    maxScans: number
    maxEntriesPerScan: number
    enumerationPageSize: number
    enumerationBudgetMs: number
    scanTtlMs: number
    maxListLimit: number
  }
}

const LIST_CURSOR_PREFIX = "l1"
const MAX_ENUMERATION_PAGES = 500

/** The scan list cursor: a position in the fixed candidate list, so it cannot drift. */
const encodeListCursor = (index: number) => `${LIST_CURSOR_PREFIX}:${index}`

const decodeListCursor = (cursor: string | undefined): number | null => {
  if (!cursor) return 0
  const [prefix, raw] = cursor.split(":")
  if (prefix !== LIST_CURSOR_PREFIX || raw === undefined) return null
  const index = Number(raw)
  return Number.isInteger(index) && index >= 0 ? index : null
}

export class LocalAgentReadingScans {
  private readonly scans = new Map<string, ScanRecord>()
  private readonly provider: LocalAgentReadingDataProvider
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly limits: NonNullable<ScansOptions["limits"]>

  constructor(options: ScansOptions) {
    this.provider = options.provider
    this.now = options.now ?? Date.now
    this.log = options.log ?? (() => {})
    this.limits = options.limits ?? {
      maxScans: LOCAL_AGENT_READING_LIMITS.maxScans,
      maxEntriesPerScan: LOCAL_AGENT_READING_LIMITS.maxEntriesPerScan,
      enumerationPageSize: LOCAL_AGENT_READING_LIMITS.enumerationPageSize,
      enumerationBudgetMs: LOCAL_AGENT_READING_LIMITS.enumerationBudgetMs,
      scanTtlMs: LOCAL_AGENT_READING_LIMITS.scanTtlMs,
      maxListLimit: LOCAL_AGENT_READING_LIMITS.maxListLimit,
    }
  }

  get activeCount(): number {
    this.prune()
    return this.scans.size
  }

  /** Drops expired scans; the id of a dropped scan is never reused. */
  prune(): void {
    const now = this.now()
    for (const [id, scan] of this.scans) {
      if (scan.expiresAt <= now) this.scans.delete(id)
    }
  }

  /** Forgets every scan, e.g. after sign-out, account switch, disable or token revocation. */
  clear(): number {
    const count = this.scans.size
    this.scans.clear()
    return count
  }

  /**
   * Enumerates the account once and pins the result.
   *
   * The enumeration is bounded by entry count, page count and time; when a bound is hit the scan is
   * reported as partial with the reason, never as a complete list of a truncation.
   */
  async begin(params: BeginScanParams): Promise<BeginScanOutcome> {
    this.prune()
    while (this.scans.size >= this.limits.maxScans) {
      const oldest = this.scans.keys().next()
      if (oldest.done) break
      this.scans.delete(oldest.value)
    }

    const startedAtMs = this.now()
    const id = randomUUID()
    const candidates: LocalAgentReadingCandidateEntry[] = []
    const seen = new Set<string>()
    const sources = new Map<string, LocalAgentReadingSourceProgress>()
    const errors: LocalAgentReadingScanError[] = []

    let duplicatesRemoved = 0
    let unknownReadStateCount = 0
    let cursor: string | null = null
    let pages = 0
    let enumerationComplete = false

    for (;;) {
      if (params.signal?.aborted) {
        errors.push({ code: "cancelled", message: "The scan was cancelled", source: null })
        break
      }
      if (this.now() - startedAtMs > this.limits.enumerationBudgetMs) {
        errors.push({
          code: "enumeration_budget_exhausted",
          message: `Enumeration stopped after ${this.limits.enumerationBudgetMs}ms`,
          source: null,
        })
        break
      }
      if (candidates.length >= this.limits.maxEntriesPerScan) {
        errors.push({
          code: "scan_limit_reached",
          message: `The scan stopped at ${this.limits.maxEntriesPerScan} candidates`,
          source: null,
        })
        break
      }
      if (pages >= MAX_ENUMERATION_PAGES) {
        errors.push({
          code: "enumeration_budget_exhausted",
          message: `Enumeration stopped after ${MAX_ENUMERATION_PAGES} pages`,
          source: null,
        })
        break
      }

      const page = await this.provider.enumerateUnread({
        accountId: params.accountId,
        scope: params.scope,
        cursor,
        limit: this.limits.enumerationPageSize,
        signal: params.signal,
      })

      if (!page.ok) {
        errors.push({
          code: page.error.code === "ACCOUNT_MISMATCH" ? "account_changed" : "provider_unavailable",
          message: page.error.message,
          source: null,
        })
        break
      }

      pages += 1
      for (const source of page.sources) {
        sources.set(`${source.kind}:${source.id}`, source)
      }
      for (const pageError of page.errors) {
        errors.push({
          code: "source_failed",
          message: `${pageError.source}: ${pageError.message}`,
          source: pageError.source,
        })
      }

      let limitReached = false
      for (const entry of page.entries) {
        // The pinned list never grows past the bound: the page is clipped, not overshot.
        if (candidates.length >= this.limits.maxEntriesPerScan) {
          limitReached = true
          break
        }

        // An entry whose read state could not be observed is not unread.
        if (entry.readState !== "unread") {
          unknownReadStateCount += 1
          continue
        }
        if (seen.has(entry.id)) {
          duplicatesRemoved += 1
          continue
        }

        seen.add(entry.id)
        candidates.push(entry)
      }

      if (limitReached) {
        errors.push({
          code: "scan_limit_reached",
          message: `The scan stopped at ${this.limits.maxEntriesPerScan} candidates`,
          source: null,
        })
        break
      }

      if (!page.cursor) {
        enumerationComplete = true
        break
      }
      if (page.cursor === cursor) {
        errors.push({
          code: "provider_unavailable",
          message: "The enumeration cursor did not advance",
          source: null,
        })
        break
      }

      cursor = page.cursor
    }

    const sourceList = [...sources.values()]
    // A source that answered partially, failed, or cannot be enumerated makes the whole selection
    // incomplete; saying otherwise would overstate the coverage the agent can report.
    const completeSources = sourceList.every((source) => source.status === "complete")
    enumerationComplete = enumerationComplete && completeSources && errors.length === 0

    const status: LocalAgentReadingScanStatus = errors.some(
      (error) => error.code === "cancelled" || error.code === "provider_unavailable",
    )
      ? "failed"
      : enumerationComplete
        ? "complete"
        : "partial"

    const scan: ScanRecord = {
      id,
      accountId: params.accountId,
      scope: params.scope,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(this.now()).toISOString(),
      expiresAt: this.now() + this.limits.scanTtlMs,
      status,
      enumerationComplete,
      candidates,
      duplicatesRemoved,
      unknownReadStateCount,
      sources: sourceList,
      errors,
    }

    this.scans.set(id, scan)
    this.log(
      `[local-agent-reading] scan ${id.slice(0, 8)} ${status}: ${candidates.length} unread candidate(s), ` +
        `${duplicatesRemoved} duplicate(s), ${unknownReadStateCount} unknown read state(s)`,
    )

    return { ok: true, scan }
  }

  get(params: { scanId: string; accountId: string }): { ok: true; scan: ScanRecord } | ScanFailure {
    const scan = this.scans.get(params.scanId)
    if (!scan) {
      return {
        ok: false,
        error: { code: "SCAN_NOT_FOUND", message: "No such scan; start a new one" },
      }
    }
    if (scan.expiresAt <= this.now()) {
      this.scans.delete(scan.id)
      return {
        ok: false,
        error: { code: "SCAN_EXPIRED", message: "The scan expired; start a new one" },
      }
    }
    if (scan.accountId !== params.accountId) {
      // The scan belongs to another account than the one signed in now.
      this.scans.delete(scan.id)
      return { ok: false, error: { code: "SCAN_NOT_FOUND", message: "No such scan" } }
    }

    return { ok: true, scan }
  }

  list(params: ListScanParams): ListScanOutcome {
    const found = this.get(params)
    if (!found.ok) return found

    const start = decodeListCursor(params.cursor)
    if (start === null) {
      return { ok: false, error: { code: "INVALID_REQUEST", message: "Unknown cursor" } }
    }

    const limit = Math.min(
      Math.max(1, params.limit ?? LOCAL_AGENT_READING_LIMITS.defaultListLimit),
      this.limits.maxListLimit,
    )
    const entries = found.scan.candidates.slice(start, start + limit)
    const next = start + entries.length
    const hasMore = next < found.scan.candidates.length

    return {
      ok: true,
      scan: found.scan,
      entries,
      cursor: hasMore ? encodeListCursor(next) : null,
      hasMore,
    }
  }

  /** The candidate entries of a scan, including whether a requested id belongs to it at all. */
  pickCandidates(scan: ScanRecord, entryIds: string[]) {
    const byId = new Map(scan.candidates.map((entry) => [entry.id, entry]))
    const selected: LocalAgentReadingCandidateEntry[] = []
    const rejected: string[] = []

    for (const entryId of entryIds) {
      const entry = byId.get(entryId)
      if (entry) selected.push(entry)
      else rejected.push(entryId)
    }

    return { selected, rejected }
  }
}

export const toScanSummary = (scan: ScanRecord): LocalAgentReadingScanSummary => ({
  scanId: scan.id,
  accountId: scan.accountId,
  scope: scan.scope,
  startedAt: scan.startedAt,
  finishedAt: scan.finishedAt,
  expiresAt: new Date(scan.expiresAt).toISOString(),
  status: scan.status,
  enumerationComplete: scan.enumerationComplete,
  selectionConsistency: "best_effort",
  selectedCount: scan.candidates.length,
  duplicatesRemoved: scan.duplicatesRemoved,
  unknownReadStateCount: scan.unknownReadStateCount,
  sources: scan.sources,
  errors: scan.errors,
})
