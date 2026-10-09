import { FeedViewType } from "@follow/constants"
import { getEntry } from "@follow/store/entry/getter"
import { useEntryStore } from "@follow/store/entry/store"

import type { AIChatContextBlock, BizUIMessage } from "../store/types"

/**
 * A self-hosted AI gateway has no access to Folo's backend, so the entry ids that the chat
 * context bar sends in `data-block` parts (and the article text behind them) have to be
 * resolved on the client and shipped along with the request.
 */
const MAX_ENTRIES = 20
const MAX_CONTENT_CHARS = 1500

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

const trimContent = (content?: string | null) => {
  if (!content) return null
  return content.length > MAX_CONTENT_CHARS ? `${content.slice(0, MAX_CONTENT_CHARS)}…` : content
}

const blockValue = (block: AIChatContextBlock) =>
  "value" in block ? String(block.value ?? "") : ""

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
      return Array.from(entryIdByView[FeedViewType.All] ?? [])
    }
    default: {
      return []
    }
  }
}

export const buildLocalAIContext = (parts: BizUIMessage["parts"]): LocalAIContext | null => {
  const blocks = parts
    .flatMap((part) => (part.type === "data-block" ? (part.data ?? []) : []))
    .filter((block) => !block.disabled)
    .map((block) => ({ type: block.type, value: blockValue(block) }))

  if (blocks.length === 0) return null

  const entryIds = new Set<string>()
  for (const block of blocks) {
    for (const entryId of blockEntryIds(block as AIChatContextBlock)) {
      entryIds.add(entryId)
    }
  }

  const entries = Array.from(entryIds)
    .map((entryId) => getEntry(entryId))
    .filter((entry): entry is NonNullable<typeof entry> => !!entry)
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
    .slice(0, MAX_ENTRIES)
    .map((entry) => ({
      id: entry.id,
      title: entry.title,
      url: entry.url,
      feedId: entry.feedId,
      publishedAt: entry.publishedAt.toISOString(),
      content: trimContent(entry.readabilityContent || entry.content || entry.description),
    }))

  if (entries.length === 0) return null

  return { blocks, entries }
}
