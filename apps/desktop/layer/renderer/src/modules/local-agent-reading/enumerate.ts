/**
 * One page of a scan's enumeration.
 *
 * The main process asks for a page at a time and bounds the whole walk; this module answers with
 * the candidates of one page plus the cursor to continue. It never finishes a source silently:
 *
 * - a source that cannot be paged is reported `failed` (or `unsupported`), never as an empty list;
 * - an entry whose read state cannot be observed is sent as `unknown`, which the main process
 *   counts but never serves as unread;
 * - a full page is a cut whose coverage cannot be verified: the account cursor carries only a
 *   publish time and nothing finer, so entries published at exactly that time can fall between two
 *   pages. Any full page marks the source `partial` — even when no second entry of the page shows
 *   that time — instead of claiming full coverage. A source that was never paged stays complete;
 * - a page that does not move past the previous one stops the source instead of looping.
 */
import type {
  LocalAgentReadingCandidateEntry,
  LocalAgentReadingEnumerationError,
  LocalAgentReadingEnumerationPage,
  LocalAgentReadingEnumerationRequest,
  LocalAgentReadingReadState,
  LocalAgentReadingScope,
  LocalAgentReadingSourceProgress,
  LocalAgentReadingSourceStatus,
} from "@follow/shared/local-agent-reading"

import type { EnumerationState } from "./cursor"
import {
  addToSourceCount,
  advanceSource,
  countOf,
  createEnumerationState,
  currentSource,
  decodeEnumerationCursor,
  encodeEnumerationCursor,
  setSourceStatus,
  statusOf,
} from "./cursor"
import { requestFailureMessage } from "./failure"
import { buildPlan, isSupportedSource } from "./plan"
import type { LocalAgentReadingDeps, PlannedSource, SourcePageItem } from "./types"
import { sourceKey } from "./types"

/**
 * Account requests one page may make. A page that has to cross several finished sources answers
 * within the provider timeout; whatever is left is walked by the next page.
 */
const MAX_FETCHES_PER_PAGE = 6
/**
 * Upper bound of a page, whatever the caller asks for. The account API answers at most 100 rows per
 * page (the app's own timeline clamps at 100), so asking for more would come back short and a short
 * page is what ends a source here.
 */
const MAX_PAGE_LIMIT = 100

const clampLimit = (limit: number) =>
  Math.min(Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 1), MAX_PAGE_LIMIT)

const toIso = (timestamp: number) => new Date(timestamp).toISOString()

const timeOf = (value: string | null | undefined): number | null => {
  if (!value) return null
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : time
}

/**
 * The read state of one row. A pending local change (a mark read/unread that has not reached the
 * server yet) wins over the snapshot, because it is what the user sees in the app.
 *
 * The walk asks the account for unread entries, so a local mark *unread* that the server has not
 * applied yet cannot add an entry here; a local mark read, on the other hand, removes one, which is
 * the direction that must not be missed.
 */
const readStateOf = (
  deps: LocalAgentReadingDeps,
  item: SourcePageItem,
): LocalAgentReadingReadState | "read" => {
  const overlay = deps.getReadOverlay(item.id)
  const effective = overlay ?? item.read
  if (effective === false) return "unread"
  if (effective === true) return "read"
  // Neither the API answer nor a local intent says: this is not unread.
  return "unknown"
}

const inScope = (item: SourcePageItem, scope: LocalAgentReadingScope | undefined) => {
  if (!scope?.publishedAfter && !scope?.publishedBefore) return true
  const publishedAt = timeOf(item.publishedAt)
  if (publishedAt === null) return false
  const after = timeOf(scope.publishedAfter)
  const before = timeOf(scope.publishedBefore)
  if (after !== null && publishedAt < after) return false
  if (before !== null && publishedAt > before) return false
  return true
}

const finishedStatus = (
  state: EnumerationState,
  source: PlannedSource,
): LocalAgentReadingSourceStatus =>
  state.boundarySources.includes(sourceKey(source)) ? "partial" : "complete"

const toProgress = (
  deps: LocalAgentReadingDeps,
  state: EnumerationState,
  source: PlannedSource,
): LocalAgentReadingSourceProgress => ({
  kind: source.kind,
  id: source.id,
  label: deps.getSourceLabel(source),
  status: statusOf(state, source),
  observedCount: countOf(state, source),
  error: null,
})

export const enumerateUnreadPage = async (
  deps: LocalAgentReadingDeps,
  request: LocalAgentReadingEnumerationRequest,
  signal?: AbortSignal,
): Promise<LocalAgentReadingEnumerationPage> => {
  const accountId = deps.getAccountId()
  if (!accountId) {
    return { ok: false, error: { code: "APP_NOT_READY", message: "Folo is not signed in" } }
  }
  if (accountId !== request.accountId) {
    return {
      ok: false,
      error: { code: "ACCOUNT_MISMATCH", message: "Folo is signed in to another account" },
      accountId,
    }
  }

  let state: EnumerationState
  if (request.cursor) {
    const decoded = decodeEnumerationCursor(request.cursor)
    if (!decoded) {
      return {
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "The scan cursor was not issued by this Folo window; start a new scan",
        },
        accountId,
      }
    }
    state = decoded
  } else {
    state = createEnumerationState(buildPlan(request.scope, deps))
  }

  const limit = clampLimit(request.limit)
  const observedAt = toIso(deps.now())
  const entries: LocalAgentReadingCandidateEntry[] = []
  const errors: LocalAgentReadingEnumerationError[] = []
  let fetches = 0

  while (
    state.index < state.sources.length &&
    entries.length < limit &&
    fetches < MAX_FETCHES_PER_PAGE
  ) {
    if (signal?.aborted) {
      return {
        ok: false,
        error: { code: "CANCELLED", message: "The request was cancelled" },
        accountId,
      }
    }

    const source = currentSource(state)!
    const key = sourceKey(source)
    fetches += 1

    if (!isSupportedSource(source)) {
      setSourceStatus(state, source, "unsupported")
      errors.push({
        source: key,
        code: "source_unsupported",
        message: `This build cannot enumerate ${key}`,
      })
      advanceSource(state)
      continue
    }

    const wanted = limit - entries.length
    let page: SourcePageItem[]
    try {
      page = await deps.listSourcePage({
        source,
        cursor: state.position,
        limit: wanted,
        signal,
      })
    } catch (error) {
      if (signal?.aborted) {
        return {
          ok: false,
          error: { code: "CANCELLED", message: "The request was cancelled" },
          accountId,
        }
      }
      setSourceStatus(state, source, "failed")
      errors.push({ source: key, code: "source_failed", message: requestFailureMessage(error) })
      advanceSource(state)
      continue
    }

    // Only as much of the page as still fits is consumed: the rest would be lost when the source
    // position moves past it.
    const consumed = page.slice(0, wanted)

    if (consumed.length === 0) {
      // An empty page is the end of the source: the account says there is nothing more here.
      setSourceStatus(state, source, finishedStatus(state, source))
      advanceSource(state)
      continue
    }

    const last = consumed.at(-1)!
    const lastTime = timeOf(last.publishedAt)
    const previousTime = timeOf(state.position)
    const morePossible = page.length >= wanted
    const advanced = previousTime === null || (lastTime !== null && lastTime < previousTime)

    // The next page is asked for with the publish time of this page's last entry, and the account
    // API offers nothing finer: who shares that instant beyond the cut cannot be observed from the
    // page itself. A full page is therefore a boundary whose coverage is unproven — also when no
    // second entry of the page carries that time — so the source never claims to be exhaustive.
    const lowerBound = timeOf(request.scope?.publishedAfter)
    const belowScope = lowerBound !== null && lastTime !== null && lastTime < lowerBound
    if (morePossible && !belowScope && !state.boundarySources.includes(key)) {
      state.boundarySources.push(key)
      const visibleTie = consumed.some(
        (item) => item !== last && item.publishedAt === last.publishedAt,
      )
      errors.push({
        source: key,
        code: visibleTie ? "timestamp_tie_boundary" : "page_boundary_unverified",
        message: visibleTie
          ? `Entries of ${key} share the publish time ${last.publishedAt ?? "unknown"} at a page ` +
            `boundary; entries published at exactly that time may be missing`
          : `The page ended at ${last.publishedAt ?? "unknown"} and the account cursor ` +
            `carries only a publish time, so entries published at exactly that time beyond this ` +
            `page cannot be ruled out`,
      })
    }

    for (const item of consumed) {
      if (!inScope(item, request.scope)) continue
      const readState = readStateOf(deps, item)
      if (readState === "read") continue

      entries.push({
        id: item.id,
        title: item.title ?? "",
        url: item.url,
        feedId: source.kind === "inbox" ? null : item.feedId,
        publishedAt: item.publishedAt,
        readState,
        readStateObservedAt: observedAt,
        hasCachedContent: false,
        source: source.kind === "inbox" ? "inbox" : "feed",
      })
      addToSourceCount(state, source, 1)
    }

    if (!advanced) {
      // The account API did not move past the previous page; stopping is the only way to avoid
      // serving the same entries forever.
      setSourceStatus(state, source, "failed")
      errors.push({
        source: key,
        code: "cursor_not_advancing",
        message: "The account API returned a page that does not move past the previous one",
      })
      advanceSource(state)
      continue
    }

    const reachedLowerBound = lowerBound !== null && lastTime !== null && lastTime <= lowerBound

    if (!morePossible || reachedLowerBound) {
      setSourceStatus(state, source, finishedStatus(state, source))
      advanceSource(state)
      continue
    }

    if (!last.publishedAt) {
      // Without a publish time there is nothing to page with: the rest of this source stays
      // unread and the scan says so.
      setSourceStatus(state, source, "failed")
      errors.push({
        source: key,
        code: "missing_publish_time",
        message: "An entry of this source has no publish time, so the source cannot be paged",
      })
      advanceSource(state)
      continue
    }

    state.position = last.publishedAt
  }

  if (entries.length > 0) {
    const stored = new Map(
      (await deps.getStoredEntries(entries.map((entry) => entry.id))).map((row) => [row.id, row]),
    )
    for (const entry of entries) {
      const row = stored.get(entry.id)
      entry.hasCachedContent = Boolean(
        row?.readabilityContent?.trim() || row?.content?.trim() || row?.description?.trim(),
      )
    }
  }

  // Signing out or switching accounts mid-page must not hand a scan of the old account to the new
  // one; the main process drops the scan on this answer.
  const accountAtEnd = deps.getAccountId()
  if (accountAtEnd !== accountId) {
    return {
      ok: false,
      error: { code: "ACCOUNT_MISMATCH", message: "Folo is signed in to another account" },
      accountId: accountAtEnd ?? undefined,
    }
  }

  const finished = state.index >= state.sources.length

  return {
    ok: true,
    accountId,
    entries,
    cursor: finished ? null : encodeEnumerationCursor(state),
    sources: state.sources.map((source) => toProgress(deps, state, source)),
    errors,
    observedAt,
  }
}
