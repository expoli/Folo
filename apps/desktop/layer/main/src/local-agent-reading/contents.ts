/**
 * Entry contents for the scans.
 *
 * Text of an entry can come from three places, and they do not mean the same thing: the text the
 * feed published, the reader text the account already extracted, and a live fetch of the article
 * page. Each answer says which one it is, whether it was cut short, and how to continue reading the
 * rest, so a summary can state its coverage instead of implying "full article".
 *
 * The page fetch reuses the guarded reader fetcher of the local AI support: only public `http(s)`
 * destinations, every redirect hop validated and pinned, and no arbitrary URL from the agent.
 */
import type {
  LocalAgentReadingCandidateEntry,
  LocalAgentReadingCompleteness,
  LocalAgentReadingContentErrorCode,
  LocalAgentReadingContentFormat,
  LocalAgentReadingContentItem,
  LocalAgentReadingContentMode,
  LocalAgentReadingContentSource,
  LocalAgentReadingContentsResult,
} from "@follow/shared/local-agent-reading"
import {
  LOCAL_AGENT_READING_LIMITS,
  LOCAL_AGENT_READING_SOURCE_PAGE_DISABLED_MESSAGE,
} from "@follow/shared/local-agent-reading"

import type { ArticleFetchResult, FetchFailure } from "../local-ai/article-text"
import { createArticleTextFetcher } from "../local-ai/article-text"
import type { LocalAgentReadingDataProvider } from "./provider"

/** Fetches one article page into readable text; injected by the tests. */
export type SourcePageFetcher = (
  url: string,
  options: { signal?: AbortSignal; timeoutMs: number },
) => Promise<ArticleFetchResult>

export interface ResolveContentsParams {
  scanId: string
  accountId: string
  candidates: LocalAgentReadingCandidateEntry[]
  mode: LocalAgentReadingContentMode
  entryIds: string[]
  cursor: string | null
  provider: LocalAgentReadingDataProvider
  signal?: AbortSignal
  fetchSourcePage?: SourcePageFetcher
  /**
   * The user's permission for `source_page`. Read right before a page is requested and again when
   * the answers come back, because it can be revoked while a page is in flight.
   */
  isSourcePageEnabled: () => boolean
  now?: () => number
}

const CURSOR_PREFIX = "c1"
const MODES: LocalAgentReadingContentMode[] = ["cached", "detail", "source_page"]

/** A continuation cursor names the entry, the mode it was read in, and the character offset. */
const encodeContentCursor = (entryId: string, mode: LocalAgentReadingContentMode, offset: number) =>
  `${CURSOR_PREFIX}:${mode}:${offset}:${entryId}`

const decodeContentCursor = (
  cursor: string,
): { entryId: string; mode: LocalAgentReadingContentMode; offset: number } | null => {
  const [prefix, mode, rawOffset, ...rest] = cursor.split(":")
  if (prefix !== CURSOR_PREFIX) return null
  if (!MODES.includes(mode as LocalAgentReadingContentMode)) return null

  const offset = Number(rawOffset)
  if (!Number.isInteger(offset) || offset < 0) return null

  const entryId = rest.join(":")
  if (!entryId) return null

  return { entryId, mode: mode as LocalAgentReadingContentMode, offset }
}

const FETCH_FAILURE_CODES: Record<FetchFailure, LocalAgentReadingContentErrorCode> = {
  unreachable: "fetch_failed",
  blocked: "blocked_destination",
  "too-short": "paywall_or_too_short",
  aborted: "timeout",
}

/**
 * The mode a call actually reads in.
 *
 * A continuation cursor carries the mode of the read it continues, so `mode` alone does not say
 * what will be fetched: a `source_page` cursor continues fetching article pages without repeating
 * the mode.
 */
export const resolveContentMode = (params: {
  mode: LocalAgentReadingContentMode
  cursor: string | null
}): LocalAgentReadingContentMode =>
  (params.cursor ? decodeContentCursor(params.cursor)?.mode : null) ?? params.mode

interface EntryText {
  content: string
  contentFormat: LocalAgentReadingContentFormat
  contentSource: LocalAgentReadingContentSource
  completeness: LocalAgentReadingCompleteness
  fetchedAt: string
  warning: LocalAgentReadingContentItem["warning"]
}

type EntryFailure = NonNullable<LocalAgentReadingContentItem["error"]>

/** Runs `tasks` with at most `limit` in flight, preserving the input order of the results. */
const mapWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = Array.from({ length: items.length })
  let cursor = 0

  const worker = async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      const item = items[index]
      if (item === undefined) return
      results[index] = await run(item)
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()),
  )

  return results
}

const itemFor = (
  entry: LocalAgentReadingCandidateEntry,
  fetchedAt: string,
): LocalAgentReadingContentItem => ({
  entryId: entry.id,
  title: entry.title,
  url: entry.url,
  contentSource: null,
  contentType: null,
  completeness: "unknown",
  fetchedAt,
  content: "",
  truncated: false,
  nextCursor: null,
  warning: null,
  error: null,
})

const failureItem = (
  entry: LocalAgentReadingCandidateEntry,
  fetchedAt: string,
  failure: EntryFailure,
): LocalAgentReadingContentItem => ({ ...itemFor(entry, fetchedAt), error: failure })

export const resolveContents = async (
  params: ResolveContentsParams,
): Promise<LocalAgentReadingContentsResult> => {
  const now = params.now ?? Date.now
  const startedAt = new Date(now()).toISOString()
  const fetchSourcePage = params.fetchSourcePage ?? createArticleTextFetcher()
  const byId = new Map(params.candidates.map((entry) => [entry.id, entry]))

  // A continuation reads one entry from a known offset; everything else is a fresh batch.
  const continuation = params.cursor ? decodeContentCursor(params.cursor) : null
  const mode = resolveContentMode({ mode: params.mode, cursor: params.cursor })
  const requested = continuation ? [continuation.entryId] : params.entryIds
  const rejectedEntryIds = requested.filter((entryId) => !byId.has(entryId))
  const targetIds = requested.filter((entryId) => byId.has(entryId))

  const texts = new Map<string, EntryText>()
  const failures = new Map<string, EntryFailure>()

  if (targetIds.length > 0) {
    const resolved = await params.provider.resolveEntries({
      accountId: params.accountId,
      entryIds: targetIds,
      includeDetail: mode !== "cached",
      signal: params.signal,
    })

    if (!resolved.ok) {
      // The batch failed before anything was read; every requested entry says so.
      const code: LocalAgentReadingContentErrorCode =
        resolved.error.code === "CANCELLED" || resolved.error.code === "TIMEOUT"
          ? "timeout"
          : "fetch_failed"
      for (const entryId of targetIds) {
        failures.set(entryId, { code, message: resolved.error.message })
      }
    } else {
      const byResolved = new Map(resolved.entries.map((entry) => [entry.entryId, entry]))

      for (const entryId of targetIds) {
        const answer = byResolved.get(entryId)

        if (!answer) {
          failures.set(entryId, {
            code: "no_content",
            message: "The account returned no entry for this id",
          })
          continue
        }
        if (answer.error) {
          failures.set(entryId, {
            code: answer.error.code === "not_found" ? "entry_not_found" : "no_content",
            message: answer.error.message,
          })
          continue
        }
        if (!answer.content) {
          failures.set(entryId, {
            code: "no_content",
            message:
              mode === "cached"
                ? "No text is cached for this entry; use the detail or source_page mode"
                : "The entry carries no text",
          })
          continue
        }

        failures.delete(entryId)
        texts.set(entryId, {
          content: answer.content,
          contentFormat: answer.contentFormat ?? "text",
          contentSource: answer.contentSource ?? "rss",
          completeness: answer.completeness,
          fetchedAt: answer.fetchedAt,
          warning:
            answer.completeness === "partial"
              ? {
                  code: "partial_content",
                  message: "The stored text is an excerpt of the article, not the whole text",
                }
              : answer.completeness === "unknown"
                ? {
                    code: "length_unknown",
                    message: "Whether the stored text is the whole article cannot be confirmed",
                  }
                : null,
        })
      }
    }
  }

  // `source_page` reads the article itself, keeping the stored text when the page cannot be read.
  // It is the only mode that leaves the account API behind, so it needs the user's permission:
  // without it no page is requested at all and every entry says why.
  if (mode === "source_page") {
    const targets = targetIds
      .map((entryId) => byId.get(entryId)!)
      .filter((entry) => typeof entry.url === "string" && /^https?:\/\//i.test(entry.url))

    const fetched = new Map<string, ArticleFetchResult>()

    if (targets.length > 0 && params.isSourcePageEnabled()) {
      const answers = await mapWithConcurrency(
        targets,
        LOCAL_AGENT_READING_LIMITS.sourcePageConcurrency,
        async (entry) => ({
          entryId: entry.id,
          result: await fetchSourcePage(entry.url!, {
            signal: params.signal,
            timeoutMs: LOCAL_AGENT_READING_LIMITS.sourcePageTimeoutMs,
          }),
        }),
      )

      // The permission can be revoked while a page is in flight; a page read under a permission
      // that no longer holds is never served, and no further page is requested.
      if (params.isSourcePageEnabled()) {
        for (const { entryId, result } of answers) fetched.set(entryId, result)
      }
    }

    for (const entry of targets) {
      const entryId = entry.id
      const previous = texts.get(entryId)
      const result = fetched.get(entryId)

      if (!result) {
        // Nothing was fetched: the stored text stays and says why the page is missing. An entry
        // without text keeps the reason it already had, instead of blaming the page.
        if (previous) {
          texts.set(entryId, {
            ...previous,
            warning: {
              code: "source_page_unavailable",
              message: `${LOCAL_AGENT_READING_SOURCE_PAGE_DISABLED_MESSAGE}; this is the stored text`,
            },
          })
        }
        continue
      }

      if (result.ok) {
        failures.delete(entryId)
        texts.set(entryId, {
          content: result.text,
          contentFormat: "text",
          contentSource: "source_page",
          // A page that parsed is not proof that the article ended: paywalls and pagination both
          // produce readable text.
          completeness: "unknown",
          fetchedAt: new Date(now()).toISOString(),
          warning: {
            code: "length_unknown",
            message: "The page was extracted locally; whether it is the whole article is unknown",
          },
        })
        continue
      }

      if (previous) {
        texts.set(entryId, {
          ...previous,
          warning: {
            code: "source_page_unavailable",
            message: `The article page could not be read (${result.reason}); this is the stored text`,
          },
        })
      } else {
        failures.set(entryId, {
          code: FETCH_FAILURE_CODES[result.reason],
          message: `The article page could not be read (${result.reason})`,
        })
      }
    }
  }

  // Assemble the requested order, chunking long texts and pointing at the rest.
  const items: LocalAgentReadingContentItem[] = []

  for (const entryId of targetIds) {
    const candidate = byId.get(entryId)!
    const text = texts.get(entryId)

    if (!text) {
      items.push(
        failureItem(
          candidate,
          startedAt,
          failures.get(entryId) ?? {
            code: "no_content",
            message: "No text could be read for this entry",
          },
        ),
      )
      continue
    }

    const offset = continuation && continuation.entryId === entryId ? continuation.offset : 0
    if (offset >= text.content.length) {
      items.push({
        ...itemFor(candidate, text.fetchedAt),
        contentSource: text.contentSource,
        contentType: text.contentFormat,
        completeness: text.completeness,
        warning: {
          code: "cursor_out_of_range",
          message: "The cursor is past the end of the text; read the entry again",
        },
      })
      continue
    }

    const chunk = text.content.slice(offset, offset + LOCAL_AGENT_READING_LIMITS.contentChunkChars)
    const end = offset + chunk.length
    const truncated = end < text.content.length

    items.push({
      entryId,
      title: candidate.title,
      url: candidate.url,
      contentSource: text.contentSource,
      contentType: text.contentFormat,
      completeness: text.completeness,
      fetchedAt: text.fetchedAt,
      content: chunk,
      truncated,
      nextCursor: truncated ? encodeContentCursor(entryId, mode, end) : null,
      warning: text.warning,
      error: null,
    })
  }

  return {
    scanId: params.scanId,
    mode,
    items,
    counts: {
      // What this call actually set out to read: a continuation reads one entry, not the batch.
      requested: requested.length,
      returned: items.filter((item) => item.error === null).length,
      failed: items.filter((item) => item.error !== null).length,
      continued: items.filter((item) => item.nextCursor !== null).length,
    },
    rejectedEntryIds,
  }
}
