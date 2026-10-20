/**
 * Text of the entries of a scan.
 *
 * The account already holds text for most entries (the feed's own content, the reader text it
 * extracted, or the description), and that is served first: reading what is stored cannot fail and
 * costs nothing. The detail API is only asked when the caller allows it (`includeDetail`), and the
 * reader text is a second chance when the detail answer carries none.
 *
 * Nothing here writes: no read state, no cache, no entry reader. The source page itself is fetched
 * by the main process, never here — this side only answers with the stored text it is asked for.
 *
 * Two rules the main process relies on:
 * - `contentSource` distinguishes the feed content (`rss`), the reader text (`readability`) and the
 *   description, and `completeness` never claims more than this side knows. A feed content can be an
 *   excerpt and an extracted text can stop at a paywall, so both are `unknown`; the description is
 *   a summary by definition and is `partial`.
 * - A failure is per entry: one entry without text does not cost the batch.
 */
import type {
  LocalAgentReadingEntriesRequest,
  LocalAgentReadingEntriesResult,
  LocalAgentReadingEntryErrorCode,
  LocalAgentReadingResolvedEntry,
} from "@follow/shared/local-agent-reading"
import { LOCAL_AGENT_READING_LIMITS } from "@follow/shared/local-agent-reading"

import { requestFailureMessage } from "./failure"
import type { LocalAgentReadingDeps, StoredEntryText } from "./types"

const toIso = (timestamp: number) => new Date(timestamp).toISOString()

const nonEmpty = (value: string | null | undefined): string | null =>
  value && value.trim() ? value : null

const entryFailure = (
  entryId: string,
  fetchedAt: string,
  code: LocalAgentReadingEntryErrorCode,
  message: string,
): LocalAgentReadingResolvedEntry => ({
  entryId,
  // The scan already carries the title and URL of the candidate.
  title: null,
  content: null,
  contentFormat: null,
  contentSource: null,
  completeness: "unknown",
  fetchedAt,
  error: { code, message },
})

/** Stored text of one entry, most complete source first. */
const storedText = (
  row: StoredEntryText,
  observedAt: string,
): LocalAgentReadingResolvedEntry | null => {
  const readability = nonEmpty(row.readabilityContent)
  if (readability) {
    return {
      entryId: row.id,
      title: null,
      content: readability,
      contentFormat: "html",
      contentSource: "readability",
      completeness: "unknown",
      fetchedAt: row.readabilityUpdatedAt ?? observedAt,
      error: null,
    }
  }

  const content = nonEmpty(row.content)
  if (content) {
    return {
      entryId: row.id,
      title: null,
      content,
      contentFormat: "html",
      contentSource: "rss",
      completeness: "unknown",
      fetchedAt: observedAt,
      error: null,
    }
  }

  const description = nonEmpty(row.description)
  if (description) {
    return {
      entryId: row.id,
      title: null,
      content: description,
      contentFormat: "text",
      contentSource: "description",
      completeness: "partial",
      fetchedAt: observedAt,
      error: null,
    }
  }

  return null
}

export const resolveEntryContents = async (
  deps: LocalAgentReadingDeps,
  request: LocalAgentReadingEntriesRequest,
  signal?: AbortSignal,
): Promise<LocalAgentReadingEntriesResult> => {
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

  const entryIds = [...new Set(request.entryIds)].slice(
    0,
    LOCAL_AGENT_READING_LIMITS.maxContentBatch,
  )
  const stored = new Map(
    (entryIds.length > 0 ? await deps.getStoredEntries(entryIds) : []).map((row) => [row.id, row]),
  )
  const entries: LocalAgentReadingResolvedEntry[] = []

  for (const entryId of entryIds) {
    if (signal?.aborted) {
      return {
        ok: false,
        error: { code: "CANCELLED", message: "The request was cancelled" },
        accountId,
      }
    }

    const observedAt = toIso(deps.now())
    const row = stored.get(entryId)
    const fromCache = row ? storedText(row, observedAt) : null
    if (fromCache) {
      entries.push(fromCache)
      continue
    }

    if (!request.includeDetail) {
      entries.push(
        entryFailure(
          entryId,
          observedAt,
          "no_content",
          "No text is stored for this entry; read it in the detail or source_page mode",
        ),
      )
      continue
    }

    const isInbox = row ? row.inboxHandle !== null : null
    let content: string | null = null
    let contentSource: "rss" | "readability" = "rss"
    let failure: string | null = null

    try {
      content = nonEmpty(await deps.loadEntryDetail(entryId, isInbox))
    } catch (error) {
      failure = requestFailureMessage(error)
    }

    if (!content) {
      try {
        content = nonEmpty(await deps.loadEntryReadability(entryId))
        contentSource = "readability"
      } catch (error) {
        failure ??= requestFailureMessage(error)
      }
    }

    if (!content) {
      entries.push(
        failure
          ? entryFailure(entryId, observedAt, "unavailable", failure)
          : entryFailure(entryId, observedAt, "no_content", "The account returned no text"),
      )
      continue
    }

    entries.push({
      entryId,
      title: null,
      content,
      contentFormat: "html",
      contentSource,
      completeness: "unknown",
      fetchedAt: observedAt,
      error: null,
    })
  }

  const accountAtEnd = deps.getAccountId()
  if (accountAtEnd !== accountId) {
    return {
      ok: false,
      error: { code: "ACCOUNT_MISMATCH", message: "Folo is signed in to another account" },
      accountId: accountAtEnd ?? undefined,
    }
  }

  return { ok: true, accountId, entries }
}
