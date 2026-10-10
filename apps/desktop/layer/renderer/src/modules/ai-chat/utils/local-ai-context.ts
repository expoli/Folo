import { FeedViewType } from "@follow/constants"
import { getLocalAIContextBudget } from "@follow/store/ai-local/config"
import { getEntry } from "@follow/store/entry/getter"
import { useEntryStore } from "@follow/store/entry/store"
import type { EntryModel } from "@follow/store/entry/types"
import type { Dayjs } from "dayjs"
import dayjs from "dayjs"

import type { AIChatContextBlock, BizUIMessage } from "../store/types"

/**
 * A self-hosted AI gateway has no access to Folo's backend, so the entry ids that the chat
 * context bar sends in `data-block` parts (and the article text behind them) have to be
 * resolved on the client and shipped along with the request.
 *
 * The gateway announces how much text its model can take (`GET /ai/chat/config`); a single
 * referenced article is sent in full, several articles share the budget and are ranked by
 * how relevant they are to the question, and anything the client has to cut is marked in the
 * text itself.
 */
export interface LocalAIContextEntry {
  id: string
  title?: string | null
  url?: string | null
  feedId?: string | null
  publishedAt?: string | null
  content?: string | null
}

/** A feed the local model may recommend; a gateway cannot read Folo's catalogue itself. */
export interface LocalAIFeedCandidate {
  id: string
  title?: string | null
  description?: string | null
  url?: string | null
}

export interface LocalAIContext {
  blocks: { type: string; value: string }[]
  entries: LocalAIContextEntry[]
  /** Only set for feed-recommendation prompts. */
  feeds?: LocalAIFeedCandidate[]
}

export interface BuildLocalAIContextOptions {
  /** The user's question; entries whose text overlaps it are sent first when several are attached. */
  question?: string
  /** Candidates for Folo's "Recommend feeds" shortcut, fetched by the caller. */
  feedCandidates?: LocalAIFeedCandidate[]
  /** Injectable clock so tests can pin relative windows. */
  now?: Dayjs
}

export interface LocalAITimelineWindow {
  start: Dayjs
  end: Dayjs
  label: string
}

const CJK_CHARACTER = /[\u3040-\u30FF\u3400-\u9FFF]/

const blockValue = (block: AIChatContextBlock) =>
  "value" in block ? String(block.value ?? "") : ""

const entryText = (entry: EntryModel) =>
  entry.readabilityContent || entry.content || entry.description || ""

/** Marks content that did not fit the gateway budget instead of dropping it silently. */
const truncateText = (text: string, limit: number) => {
  if (text.length <= limit) return text

  return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`
}

const MENTION_DATE_TAG = /<mention-date\b([^>]*)>/gi

const readAttribute = (attributes: string, name: string) =>
  new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "i").exec(attributes)?.[1]

const normalizeRelativeHint = (hint: string) =>
  hint
    .toLowerCase()
    .replace(/^date:relative:/, "")
    .replace(/[\s_-]+/g, "")

/** Day offsets of the relative presets the mention menu offers. */
const RELATIVE_WINDOW_DAYS: Record<string, number> = {
  last3days: 2,
  last7days: 6,
  last15days: 14,
  last30days: 29,
}

const parseRelativeWindow = (hint: string, now: Dayjs): LocalAITimelineWindow | null => {
  const normalized = normalizeRelativeHint(hint)

  switch (normalized) {
    case "today": {
      return { start: now.startOf("day"), end: now, label: "today" }
    }
    case "yesterday": {
      const day = now.subtract(1, "day")
      return { start: day.startOf("day"), end: day.endOf("day"), label: "yesterday" }
    }
    case "thisweek": {
      return { start: now.startOf("week"), end: now, label: "this week" }
    }
    case "lastweek": {
      const start = now.subtract(1, "week").startOf("week")
      return { start, end: start.add(6, "day").endOf("day"), label: "last week" }
    }
    case "thismonth": {
      return { start: now.startOf("month"), end: now, label: "this month" }
    }
    case "lastmonth": {
      const month = now.subtract(1, "month")
      return { start: month.startOf("month"), end: month.endOf("month"), label: "last month" }
    }
    default: {
      break
    }
  }

  const days = RELATIVE_WINDOW_DAYS[normalized]
  if (days !== undefined) {
    return {
      start: now.subtract(days, "day").startOf("day"),
      end: now,
      label: `last ${days + 1} days`,
    }
  }

  // Folo's own shortcut prompts carry plain phrasings such as `24hoursago`, which its server
  // resolves. A local gateway cannot, so the client reads them here.
  const match = /^(\d+)(hour|day|week|month)s?(?:ago|before)?$/.exec(normalized)
  if (match) {
    const amount = Number(match[1])
    const unit = match[2] as "hour" | "day" | "week" | "month"
    if (amount > 0) {
      return {
        start: now.subtract(amount, unit),
        end: now,
        label: `last ${amount} ${unit}${amount === 1 ? "" : "s"}`,
      }
    }
  }

  return null
}

/**
 * The window a prompt asks about. Folo writes date mentions as
 * `<mention-date start="…" end="…" text="…">`; its built-in shortcuts only carry the relative
 * hint (`text="24hoursago"`) because the server resolves it, so this handles both forms.
 */
export const parseMentionDateWindow = (
  text: string,
  now: Dayjs = dayjs(),
): LocalAITimelineWindow | null => {
  if (!text) return null

  MENTION_DATE_TAG.lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = MENTION_DATE_TAG.exec(text)) !== null) {
    const attributes = match[1] ?? ""
    const startIso = readAttribute(attributes, "start")
    const endIso = readAttribute(attributes, "end")

    if (startIso && endIso) {
      const start = dayjs(startIso)
      const end = dayjs(endIso)
      if (start.isValid() && end.isValid()) {
        // A midnight end is exclusive — the mention covers the day before it — except when start
        // and end are the same instant: the menu's single-day presets ("yesterday") serialise that
        // way, and there the mention means that whole day.
        const isMidnightEnd =
          end.hour() === 0 && end.minute() === 0 && end.second() === 0 && end.millisecond() === 0
        const inclusiveEnd = isMidnightEnd
          ? end.isAfter(start)
            ? end.subtract(1, "millisecond")
            : end.endOf("day")
          : end

        return {
          start,
          end: inclusiveEnd,
          label: start.isSame(inclusiveEnd, "day")
            ? start.format("YYYY-MM-DD")
            : `${start.format("YYYY-MM-DD")} – ${inclusiveEnd.format("YYYY-MM-DD")}`,
        }
      }
    }

    const hint = readAttribute(attributes, "text")
    if (hint) {
      const window = parseRelativeWindow(hint, now)
      if (window) return window
    }
  }

  return null
}

/** Writes entries into the gateway payload while staying inside the announced text budget. */
const takeEntries = (
  ordered: EntryModel[],
  options: {
    maxEntries: number
    perEntryLimit: number
    budget: ReturnType<typeof getLocalAIContextBudget>
  },
): LocalAIContextEntry[] => {
  const entries: LocalAIContextEntry[] = []
  let remainingChars = options.budget.maxTotalChars

  for (const entry of ordered.slice(0, options.maxEntries)) {
    if (remainingChars <= 0) break

    const source = entryText(entry).trim()
    const limit = Math.min(options.perEntryLimit, remainingChars)
    const content = source ? truncateText(source, limit) : null
    // Charge what actually travels against the budget, inline truncation marker included.
    remainingChars -= content?.length ?? 0

    entries.push({
      id: entry.id,
      title: entry.title,
      url: entry.url,
      feedId: entry.feedId,
      publishedAt: entry.publishedAt.toISOString(),
      content,
    })
  }

  return entries
}

/**
 * Folo's "Summarize timeline" shortcut ships an empty context block and lets the server read the
 * timeline. Locally the client gathers the entries the prompt asks about (its date window).
 */
const buildTimelineContext = (
  question: string,
  now: Dayjs,
): { label: string; entries: LocalAIContextEntry[] } | null => {
  const window = parseMentionDateWindow(question, now)
  if (!window) return null

  const budget = getLocalAIContextBudget()
  const viewIds = useEntryStore.getState().entryIdByView[FeedViewType.All] ?? new Set<string>()
  const inWindow = Array.from(viewIds)
    .map((entryId) => getEntry(entryId))
    .filter((entry): entry is EntryModel => !!entry)
    .filter((entry) => {
      const publishedAt = entry.publishedAt.getTime()
      return publishedAt >= window.start.valueOf() && publishedAt <= window.end.valueOf()
    })
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())

  if (inWindow.length === 0) return null

  // A timeline summary wants breadth, so the text budget is shared between the entries.
  const considered = Math.min(inWindow.length, budget.maxEntries)
  const entries = takeEntries(inWindow, {
    maxEntries: budget.maxEntries,
    perEntryLimit: Math.min(
      budget.maxCharsPerEntry,
      Math.max(1, Math.floor(budget.maxTotalChars / considered)),
    ),
    budget,
  })

  return entries.length > 0 ? { label: window.label, entries } : null
}

/**
 * What the context blocks describe: the timeline a message is about plus the filter on it.
 * `unreadOnly` is a filter, not a scope of its own — upstream the server reads "the current
 * timeline, unread only", so a union of both would answer about the whole timeline instead.
 */
interface ContextScope {
  feedIds: string[]
  view: FeedViewType | null
  onlyUnread: boolean
}

const readContextScope = (blocks: { type: string; value: string }[]): ContextScope => {
  const feedIds: string[] = []
  let view: FeedViewType | null = null

  for (const block of blocks) {
    if (block.type === "mainFeed" && block.value) {
      // A folder block carries its feeds comma-joined.
      for (const feedId of block.value.split(",")) {
        if (feedId.trim()) feedIds.push(feedId.trim())
      }
    } else if (block.type === "mainView" && block.value) {
      const parsed = Number(block.value)
      view = Number.isFinite(parsed) ? (parsed as FeedViewType) : null
    }
  }

  return {
    feedIds,
    view,
    onlyUnread: blocks.some((block) => block.type === "unreadOnly"),
  }
}

/** Entries of the described timeline: the narrower one if there is one, unread only when asked. */
const resolveScopeEntries = (scope: ContextScope): EntryModel[] => {
  const { entryIdByView, entryIdByFeed } = useEntryStore.getState()
  const ids = scope.feedIds.length
    ? new Set(scope.feedIds.flatMap((feedId) => Array.from(entryIdByFeed[feedId] ?? [])))
    : new Set(Array.from(entryIdByView[scope.view ?? FeedViewType.All] ?? []))

  const entries = Array.from(ids)
    .map((entryId) => getEntry(entryId))
    .filter((entry): entry is EntryModel => !!entry)

  return scope.onlyUnread ? entries.filter((entry) => entry.read === false) : entries
}

/** Loose lexical terms: latin words of 2+ characters plus single CJK characters. */
const questionTerms = (question?: string) => {
  const terms = new Set<string>()
  if (!question) return terms

  const normalized = question.toLowerCase()
  for (const token of normalized.split(/[^\p{L}\p{N}]+/u)) {
    if (token.length >= 2) terms.add(token)
  }
  for (const character of normalized) {
    if (CJK_CHARACTER.test(character)) terms.add(character)
  }

  return terms
}

const overlapScore = (entry: EntryModel, terms: Set<string>) => {
  if (terms.size === 0) return 0

  const haystack = `${entry.title ?? ""}\n${entryText(entry).slice(0, 4000)}`.toLowerCase()

  let score = 0
  for (const term of terms) {
    if (haystack.includes(term)) score += 1
  }
  return score
}

/** The text the user typed, read the same way the gateway reads request messages. */
export const localAIContextQuestion = (parts: BizUIMessage["parts"]): string => {
  const texts: string[] = []

  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      texts.push(part.text)
    } else if (part.type === "data-rich-text") {
      const data: { text?: unknown } | null | undefined = part.data
      if (typeof data?.text === "string") texts.push(data.text)
    }
  }

  return texts.join("\n").trim()
}

export const buildLocalAIContext = (
  parts: BizUIMessage["parts"],
  options: BuildLocalAIContextOptions = {},
): LocalAIContext | null => {
  const blocks = parts
    .flatMap((part) => (part.type === "data-block" ? (part.data ?? []) : []))
    .filter((block) => !block.disabled)
    .map((block) => ({ type: block.type, value: blockValue(block) }))

  const question = options.question ?? localAIContextQuestion(parts)
  const feeds = options.feedCandidates?.length ? options.feedCandidates : null

  if (blocks.length === 0) {
    // Folo's built-in shortcuts ship no context blocks (upstream the server resolves them), so the
    // client gathers what a local gateway cannot reach itself.
    const timeline = buildTimelineContext(question, options.now ?? dayjs())
    if (!timeline && !feeds) return null

    return {
      blocks: [
        ...(timeline ? [{ type: "timeline", value: timeline.label }] : []),
        ...(feeds ? [{ type: "feedCandidates", value: String(feeds.length) }] : []),
      ],
      entries: timeline?.entries ?? [],
      ...(feeds ? { feeds } : {}),
    }
  }

  const explicitEntryIds = new Set(
    blocks.filter((block) => block.type === "mainEntry" && block.value).map((block) => block.value),
  )

  // A timeline block scopes the request: the feed or view it names, unread only when also asked.
  // Without one (an article chat) the candidates are the explicitly referenced entries alone.
  const hasTimelineBlock = blocks.some(
    (block) =>
      block.type === "mainFeed" || block.type === "mainView" || block.type === "unreadOnly",
  )
  const candidates: EntryModel[] = hasTimelineBlock
    ? resolveScopeEntries(readContextScope(blocks))
    : []

  if (hasTimelineBlock) {
    const seen = new Set(candidates.map((entry) => entry.id))
    for (const entryId of explicitEntryIds) {
      const entry = getEntry(entryId)
      // A referenced article stays in the context even when the filter would drop it.
      if (entry && !seen.has(entry.id)) {
        candidates.push(entry)
        seen.add(entry.id)
      }
    }
  } else {
    for (const entryId of explicitEntryIds) {
      const entry = getEntry(entryId)
      if (entry) candidates.push(entry)
    }
  }

  if (candidates.length === 0) return null

  const budget = getLocalAIContextBudget()
  const terms = questionTerms(question)
  // Score every candidate once: compare runs O(n log n) times and scoring reads entry text,
  // so scoring inside it would stall the renderer on large views.
  const overlapScores =
    terms.size > 0
      ? new Map(candidates.map((entry) => [entry.id, overlapScore(entry, terms)]))
      : null

  // Explicit references first, then entries the question talks about, then the newest ones.
  const ordered = [...candidates].sort((a, b) => {
    const explicit = Number(explicitEntryIds.has(b.id)) - Number(explicitEntryIds.has(a.id))
    if (explicit !== 0) return explicit

    const overlap = (overlapScores?.get(b.id) ?? 0) - (overlapScores?.get(a.id) ?? 0)
    if (overlap !== 0) return overlap

    return b.publishedAt.getTime() - a.publishedAt.getTime()
  })

  // A single article is the subject of the conversation, so it travels in full.
  const singleEntry = ordered.length === 1
  const entries = takeEntries(ordered, {
    maxEntries: singleEntry ? 1 : budget.maxEntries,
    perEntryLimit: singleEntry ? budget.maxTotalChars : budget.maxCharsPerEntry,
    budget,
  })

  if (entries.length === 0) return null

  return { blocks, entries }
}
