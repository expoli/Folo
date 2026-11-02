/**
 * The scope a chat's tools read when the model names none.
 *
 * The panel's context blocks describe the timeline the user is looking at; a local model sees them
 * as opaque values (a feed id, a view number) and, left alone, omits `scope` — which the reading
 * contract defines as the whole account. That is why an "unread" question asked on one feed came
 * back about another. Resolving the blocks here keeps the tools on the same timeline the client
 * already uses for the entries it attaches (`resolveScopeEntries`): the feed when one is named,
 * the view otherwise.
 */
import type { LocalAgentReadingScope } from "@follow/shared/local-agent-reading"

import type { LocalAgentReadingToolHandlers } from "~/local-agent-reading/server"

interface ScopeBlock {
  type?: unknown
  value?: unknown
}

/**
 * The narrower selection the blocks name, or `undefined` when they name none.
 *
 * A feed is narrower than its view, so when both are attached (the context bar adds `mainView`
 * and `mainFeed` for the same route) only the feeds are kept; asking for both would page the
 * whole view as well and widen what the user selected.
 */
export const scopeFromContextBlocks = (
  blocks: ScopeBlock[] | undefined,
): LocalAgentReadingScope | undefined => {
  const feedIds: string[] = []
  const views: number[] = []

  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block) continue

    if (block.type === "mainFeed") {
      const value = typeof block.value === "string" ? block.value.trim() : ""
      for (const feedId of value.split(",")) {
        const trimmed = feedId.trim()
        if (trimmed && !feedIds.includes(trimmed)) feedIds.push(trimmed)
      }
    } else if (block.type === "mainView") {
      const value = typeof block.value === "string" ? block.value.trim() : ""
      const view = Number(value)
      if (value !== "" && Number.isFinite(view) && !views.includes(view)) views.push(view)
    }
  }

  if (feedIds.length > 0) return { feedIds }
  if (views.length > 0) return { views }
  return undefined
}

interface ScopeContext {
  blocks?: ScopeBlock[]
  coverage?: {
    matched?: unknown
    window?: unknown
    publishedAfter?: unknown
    publishedBefore?: unknown
  }
}

/** An ISO instant for a bound the client sent, or `null` when it is missing or unreadable. */
const isoInstant = (value: unknown): string | null => {
  if (typeof value !== "string" || !value) return null
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

/**
 * The scope a request's context describes: the timeline it names plus the period its prompt named.
 *
 * The client already cuts the attached entries to that period ("today" means today's entries); a
 * scan that ignored the bounds would answer about a wider time than the question.
 */
export const scopeFromContext = (
  context: ScopeContext | null | undefined,
): LocalAgentReadingScope | undefined => {
  const base = scopeFromContextBlocks(context?.blocks)
  const publishedAfter = isoInstant(context?.coverage?.publishedAfter)
  const publishedBefore = isoInstant(context?.coverage?.publishedBefore)
  if (!publishedAfter && !publishedBefore) return base

  return {
    ...(base ?? {}),
    ...(publishedAfter ? { publishedAfter } : {}),
    ...(publishedBefore ? { publishedBefore } : {}),
  }
}

/**
 * Applies the panel's selection to a scan the model did not scope itself.
 *
 * A model that names any source of its own has taken over the narrowing — merging the panel's feed
 * back in would page that feed as well as the view it asked for. An explicit `feedIds: []` is such
 * a decision too: it says "across every source" and must not be narrowed back.
 * Source overrides leave the panel's period intact unless the model supplies new time bounds.
 */
export const withDefaultScope = (
  handlers: LocalAgentReadingToolHandlers,
  scope: LocalAgentReadingScope | undefined,
): LocalAgentReadingToolHandlers => {
  if (!scope) return handlers

  return {
    ...handlers,
    beginScan: (args) => {
      const asked = args?.scope
      const narrowed =
        asked &&
        (Object.hasOwn(asked, "feedIds") ||
          Object.hasOwn(asked, "views") ||
          Object.hasOwn(asked, "inboxIds"))
      const defaults = narrowed
        ? {
            ...(scope.publishedAfter ? { publishedAfter: scope.publishedAfter } : {}),
            ...(scope.publishedBefore ? { publishedBefore: scope.publishedBefore } : {}),
          }
        : scope

      return handlers.beginScan({
        ...args,
        scope: { ...defaults, ...(asked ?? {}) },
      })
    },
  }
}
