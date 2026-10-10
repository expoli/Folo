/**
 * Article texts for the entries a summary is about.
 *
 * A timeline summary is only as good as what it reads: an entry that was never opened carries the
 * excerpt its feed published, which is often a single sentence. Before the reduce pre-pass runs,
 * the pages of those entries are fetched and parsed here (through Chromium's network stack, so the
 * app's proxy settings apply) and the result replaces the excerpt as the text to summarize.
 *
 * This is best effort by design: the machine may not reach every host, so each fetch has its own
 * timeout, the whole pass has a budget, failures keep the text the entry already had, and the
 * coverage note of the request still says what was read and what was not.
 */
import { readability } from "@follow-app/readability"

import { netFetch } from "./http"

/** Text shorter than this is likely the feed's excerpt rather than the article. */
export const FETCH_MIN_CHARS = 1200
/** Entries fetched for one request; a summary of a whole day rarely needs more. */
export const FETCH_MAX_ENTRIES = 40
/** Pages fetched at the same time. */
export const FETCH_CONCURRENCY = 4
/** One page that does not answer must not hold the whole summary. */
export const FETCH_TIMEOUT_MS = 12_000
/** The whole pass gives up after this long, so a chat never waits on the network for minutes. */
export const FETCH_BUDGET_MS = 45_000
/** Per fetched entry, matching the client's own allowance for the text it sends for summarizing. */
export const FETCH_BODY_CHARS = 6000
/** All fetched texts of one request together; beyond it the entries keep what they arrived with. */
export const FETCH_TOTAL_BODY_CHARS = 200_000

export interface FetchTarget {
  /** Position among the entries, 1-based, as the prompt numbers them. */
  index: number
  url: string
}

/**
 * Why a page did not yield an article: the host could not be read, the page parsed to less than an
 * excerpt (paywall, cookie wall, a listing), or the request was stopped.
 */
export type FetchFailure = "unreachable" | "too-short" | "aborted"

export type ArticleFetchResult = { ok: true; text: string } | { ok: false; reason: FetchFailure }

export type ArticleFetcher = (
  url: string,
  options: { signal?: AbortSignal; timeoutMs: number },
) => Promise<ArticleFetchResult>

/**
 * True when the text looks like the markup of a page instead of what a reader would read.
 *
 * Two block tags, or one that is explicitly closed: a lone `<div>` in a code sample is text, and
 * flattening it would eat the sample.
 */
export const looksLikeHtml = (text: string) => {
  const blockTags =
    text
      .slice(0, 4000)
      .match(
        /<\/?(?:p|div|section|article|br|span|h[1-6]|ul|ol|li|figure|blockquote|table)\b[^>]*>/gi,
      ) ?? []

  return blockTags.length >= 2 || blockTags.some((tag) => tag.startsWith("</"))
}

/** Flattens markup into readable text: the model wants sentences, not tags. */
export const htmlToText = (text: string) =>
  text
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|section|article|h[1-6]|li|blockquote|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

/** The text a prompt should carry: the markup of a page, when that is what arrived, flattened. */
export const promptText = (text: string) => (looksLikeHtml(text) ? htmlToText(text) : text)

/** Fetches and parses one article, saying why a page did not become one. */
export const fetchArticleText: ArticleFetcher = async (url, { signal, timeoutMs }) => {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener("abort", abort, { once: true })
  const timeout = setTimeout(abort, timeoutMs)
  timeout.unref?.()

  try {
    const result = await readability(url, {
      fetch: (input, init) => netFetch(input, { ...init, signal: controller.signal }),
    })

    const text = typeof result?.textContent === "string" ? result.textContent.trim() : ""
    if (signal?.aborted) return { ok: false, reason: "aborted" }

    // The pass exists because a short excerpt was too little: something that parses shorter than
    // one is usually a paywall, a cookie wall or a stub, and the excerpt reads better.
    return text.length >= FETCH_MIN_CHARS ? { ok: true, text } : { ok: false, reason: "too-short" }
  } catch {
    // Unreachable, blocked, not a page, timed out: the entry keeps the text it arrived with.
    return { ok: false, reason: signal?.aborted ? "aborted" : "unreachable" }
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", abort)
  }
}

/** The entries worth fetching: those whose text is a short one and which point somewhere. */
export const collectFetchTargets = (
  entries: { url?: unknown; content?: unknown; body?: unknown }[],
  options: { minChars?: number; maxEntries?: number } = {},
): FetchTarget[] => {
  const minChars = options.minChars ?? FETCH_MIN_CHARS
  const maxEntries = options.maxEntries ?? FETCH_MAX_ENTRIES

  return entries
    .map((entry, position) => ({ entry, index: position + 1 }))
    .filter(({ entry }) => {
      const url = typeof entry.url === "string" ? entry.url.trim() : ""
      if (!/^https?:\/\//i.test(url)) return false

      const text = [entry.content, entry.body].find(
        (value): value is string => typeof value === "string" && !!value,
      )
      // No text at all is worth fetching too: it is the difference between a title and a note.
      return !text || text.length < minChars
    })
    .slice(0, maxEntries)
    .map(({ entry, index }) => ({ index, url: String(entry.url).trim() }))
}

export interface FetchedArticles {
  /** Entry position → the article text, only for the fetches that produced one. */
  texts: Map<number, string>
  attempted: number
  /** How many pages failed, and why: a different reason needs a different answer. */
  failures: Record<FetchFailure, number>
  /** Pages never started because the pass ran out of its time budget. */
  skipped: number
}

/** Fetches the targets with a bounded pool, reporting progress as it goes. */
export const fetchArticleTexts = async (params: {
  targets: FetchTarget[]
  fetchText?: ArticleFetcher
  concurrency?: number
  timeoutMs?: number
  /** How long the whole pass may take before it stops starting new pages. */
  budgetMs?: number
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
  log?: (line: string) => void
}): Promise<FetchedArticles> => {
  const {
    targets,
    fetchText = fetchArticleText,
    concurrency = FETCH_CONCURRENCY,
    timeoutMs = FETCH_TIMEOUT_MS,
    budgetMs = FETCH_BUDGET_MS,
    signal,
    onProgress,
    log,
  } = params
  const texts = new Map<number, string>()
  const startedAt = Date.now()
  const failures: Record<FetchFailure, number> = { unreachable: 0, "too-short": 0, aborted: 0 }
  let cursor = 0
  let done = 0
  let skipped = 0

  onProgress?.(0, targets.length)

  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return
      if (Date.now() - startedAt > budgetMs) {
        skipped = targets.length - done
        return
      }

      const target = targets[cursor]
      cursor += 1
      if (!target) return

      const result = await fetchText(target.url, { signal, timeoutMs })
      if (result.ok) texts.set(target.index, result.text)
      else failures[result.reason] += 1

      done += 1
      onProgress?.(done, targets.length)
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, targets.length)) }, () => worker()),
  )

  const reasons = [
    failures.unreachable > 0 ? `${failures.unreachable} unreachable` : "",
    failures["too-short"] > 0 ? `${failures["too-short"]} too short to be an article` : "",
    failures.aborted > 0 ? `${failures.aborted} stopped` : "",
    skipped > 0 ? `${skipped} skipped after ${budgetMs}ms` : "",
  ].filter(Boolean)

  log?.(
    `[local-ai] fetch: ${texts.size} of ${targets.length} article text(s) read` +
      `${reasons.length > 0 ? ` (${reasons.join(", ")})` : ""} in ${Date.now() - startedAt}ms`,
  )

  return { texts, attempted: targets.length, failures, skipped }
}

/**
 * Puts the fetched texts where the request will read them: an entry that already carried a verbatim
 * text keeps its place in the prompt (replaced by the longer article, cut to its share of the
 * budget), an entry that had none now travels for the reduce pre-pass like any other.
 */
export const applyFetchedTexts = <T extends { content?: unknown; body?: unknown }>(
  entries: T[],
  texts: Map<number, string>,
  options: { verbatimChars?: number; bodyChars?: number; totalBodyChars?: number } = {},
): number => {
  let applied = 0
  const verbatimChars = options.verbatimChars ?? 0
  // A fetched text is a body for the reduce pre-pass, and the client caps those for the same
  // reason: one long page must not become a batch of its own (or a doomed provider call).
  const bodyChars = options.bodyChars ?? FETCH_BODY_CHARS
  let remainingBody = options.totalBodyChars ?? FETCH_TOTAL_BODY_CHARS

  for (const [index, text] of texts) {
    const entry = entries[index - 1]
    if (!entry) continue

    const existing = [entry.content, entry.body].find(
      (value): value is string => typeof value === "string" && !!value,
    )
    if (existing && existing.length >= text.length) continue

    if (typeof entry.content === "string" && entry.content) {
      // The prompt shows this entry in full: keep it there, within its share of the budget.
      const limit = verbatimChars > 0 ? verbatimChars : text.length
      entry.content = text.length <= limit ? text : text.slice(0, limit)
    } else {
      const limit = Math.min(bodyChars, remainingBody)
      if (limit <= 0) continue

      entry.body = text.length <= limit ? text : text.slice(0, limit)
      remainingBody -= (entry.body as string).length
    }

    applied += 1
  }

  return applied
}
