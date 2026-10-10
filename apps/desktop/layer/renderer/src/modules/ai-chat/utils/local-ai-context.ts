import { FeedViewType } from "@follow/constants"
import { getLocalAIContextBudget } from "@follow/store/ai-local/config"
import { getEntry } from "@follow/store/entry/getter"
import { useEntryStore } from "@follow/store/entry/store"
import type { EntryModel } from "@follow/store/entry/types"

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

export interface LocalAIContext {
  blocks: { type: string; value: string }[]
  entries: LocalAIContextEntry[]
}

export interface BuildLocalAIContextOptions {
  /** The user's question; entries whose text overlaps it are sent first when several are attached. */
  question?: string
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

const blockEntryIds = (block: AIChatContextBlock): string[] => {
  const { entryIdByView, entryIdByFeed } = useEntryStore.getState()

  switch (block.type) {
    case "mainEntry": {
      return block.value ? [block.value] : []
    }
    case "mainFeed": {
      return Array.from(entryIdByFeed[block.value] ?? [])
    }
    case "mainView": {
      const view = Number(block.value)
      const viewIds =
        entryIdByView[(Number.isFinite(view) ? view : FeedViewType.All) as FeedViewType]
      return Array.from(viewIds ?? [])
    }
    case "unreadOnly": {
      // `entryIdByView[All]` holds every loaded entry; the block only means the unread ones.
      return Array.from(entryIdByView[FeedViewType.All] ?? []).filter((entryId) => {
        const entry = getEntry(entryId)
        return entry ? entry.read === false : false
      })
    }
    default: {
      return []
    }
  }
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

  if (blocks.length === 0) return null

  const explicitEntryIds = new Set(
    blocks.filter((block) => block.type === "mainEntry" && block.value).map((block) => block.value),
  )

  const entryIds = new Set<string>()
  for (const block of blocks) {
    for (const entryId of blockEntryIds(block as AIChatContextBlock)) {
      entryIds.add(entryId)
    }
  }

  const candidates = Array.from(entryIds)
    .map((entryId) => getEntry(entryId))
    .filter((entry): entry is NonNullable<typeof entry> => !!entry)

  if (candidates.length === 0) return null

  const budget = getLocalAIContextBudget()
  const terms = questionTerms(options.question)
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
  const maxEntries = singleEntry ? 1 : budget.maxEntries
  const perEntryLimit = singleEntry ? budget.maxTotalChars : budget.maxCharsPerEntry

  const entries: LocalAIContextEntry[] = []
  let remainingChars = budget.maxTotalChars

  for (const entry of ordered.slice(0, maxEntries)) {
    if (remainingChars <= 0) break

    const source = entryText(entry).trim()
    const limit = Math.min(perEntryLimit, remainingChars)
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

  if (entries.length === 0) return null

  return { blocks, entries }
}
