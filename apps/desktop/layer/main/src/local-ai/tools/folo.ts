/**
 * The app's own chat tools: the reading service's four read-only operations, plus a digest that
 * does in one call what a recap would otherwise need six steps for.
 *
 * Wording and input schemas of the four come from `@follow/shared/local-agent-reading` — the same
 * objects the loopback MCP endpoint registers — so a model that reads Folo through the chat panel
 * and one that reads it through the endpoint get the same description and the same validation.
 *
 * The digest stays here: it is composed from the same handlers, so it adds a convenience without
 * widening what either caller may read.
 */
import type {
  LocalAgentReadingContentsResult,
  LocalAgentReadingScope,
  LocalAIDigestArgs,
  LocalAIDigestWindow,
} from "@follow/shared/local-agent-reading"
import {
  LOCAL_AGENT_READING_LIMITS,
  LOCAL_AGENT_READING_TOOL_INFO,
  LOCAL_AI_DIGEST_LIMITS,
  LOCAL_AI_DIGEST_TOOL_NAME,
  localAgentReadingBeginScanArgsSchema,
  localAgentReadingContentsArgsSchema,
  localAgentReadingListArgsSchema,
  localAIDigestArgsSchema,
} from "@follow/shared/local-agent-reading"
import type { ToolSet } from "ai"
import { jsonSchema, tool } from "ai"

import type { LocalAgentReadingToolHandlers, ToolAnswer } from "~/local-agent-reading/server"

/**
 * What a tool hands back to the model: the payload on success, the refusal otherwise.
 *
 * A refusal is an answer, not an exception: the model can act on `NOT_SIGNED_IN` or `SCAN_EXPIRED`
 * only if it reads them, so the loop keeps running. Real failures (the provider went away) still
 * throw and surface as a failed tool call.
 */
const answer = <T>(result: ToolAnswer<T>) => (result.ok ? result.data : { error: result.error })

const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0)

/**
 * A named window as the two timestamps the service understands.
 *
 * Local time on purpose: "today" means the reader's day, not UTC's. A model asked to convert
 * "today" into an ISO range routinely gets it wrong, and the range is knowable exactly here.
 */
const windowRange = (window: LocalAIDigestWindow, now: number) => {
  const at = new Date(now)
  switch (window) {
    case "today": {
      return { from: startOfDay(at), to: at }
    }
    case "yesterday": {
      const day = new Date(at)
      day.setDate(day.getDate() - 1)
      const from = startOfDay(day)
      return { from, to: new Date(from.getTime() + 24 * 60 * 60 * 1000 - 1) }
    }
    case "last24h": {
      return { from: new Date(at.getTime() - 24 * 60 * 60 * 1000), to: at }
    }
    case "last7d": {
      return { from: new Date(at.getTime() - 7 * 24 * 60 * 60 * 1000), to: at }
    }
  }
}

/** Splits ids into batches the service accepts, so a digest may name more than one batch. */
const inBatches = <T>(values: T[], size: number): T[][] => {
  const batches: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size))
  }
  return batches
}

/**
 * Bounds one contents answer.
 *
 * Ten entries of six thousand characters each is more than a recap needs; keeping earlier entries
 * whole and marking the ones that lost their text is more honest than truncating every entry or
 * silently returning less.
 */
const capContents = (
  result: LocalAgentReadingContentsResult,
  maxChars: number,
): LocalAgentReadingContentsResult => {
  let budget = maxChars
  let capped = false

  const items = result.items.map((item) => {
    if (!item.content) return item
    if (item.content.length <= budget) {
      budget -= item.content.length
      return item
    }

    capped = true
    const kept = item.content.slice(0, Math.max(0, budget))
    budget = 0
    return {
      ...item,
      content: kept,
      truncated: true,
      warning: item.warning ?? {
        code: "partial_content" as const,
        message: `Text capped at ${maxChars} characters for this answer`,
      },
    }
  })

  return capped ? { ...result, items } : result
}

const digestDescription = [
  "One call for a recap of the unread entries: it scans, lists and reads them, so a summary does",
  "not need a scan, a listing and several content calls. `window` is resolved against the reader's",
  "local clock; explicit `scope.publishedAfter`/`publishedBefore` win over it. Returns the entries",
  "with an excerpt of their text, plus whether the enumeration was complete and which sources were",
  "partial — report that coverage instead of implying the whole account was read.",
].join(" ")

interface DigestOptions {
  handlers: LocalAgentReadingToolHandlers
  /** Injectable clock so a test can pin "today". */
  now: () => number
}

const createDigest =
  ({ handlers, now }: DigestOptions) =>
  async (args: LocalAIDigestArgs) => {
    const limit = Math.min(
      args.limit ?? LOCAL_AI_DIGEST_LIMITS.defaultEntries,
      LOCAL_AI_DIGEST_LIMITS.maxEntries,
    )
    const bodiesPerEntry = Math.min(
      args.bodiesPerEntry ?? LOCAL_AI_DIGEST_LIMITS.defaultBodiesPerEntry,
      LOCAL_AI_DIGEST_LIMITS.maxBodiesPerEntry,
      // Whatever the caller asks for, one answer stays within its budget.
      Math.max(1, Math.floor(LOCAL_AI_DIGEST_LIMITS.resultChars / Math.max(1, limit))),
    )
    const range = args.window ? windowRange(args.window, now()) : null
    const scope: LocalAgentReadingScope = {
      ...(args.scope ?? {}),
      ...(range && !args.scope?.publishedAfter ? { publishedAfter: range.from.toISOString() } : {}),
      ...(range && !args.scope?.publishedBefore ? { publishedBefore: range.to.toISOString() } : {}),
    }

    const scan = await handlers.beginScan({ scope })
    if (!scan.ok) return { error: scan.error }

    const page = await handlers.listEntries({
      scanId: scan.data.scanId,
      limit: Math.min(LOCAL_AGENT_READING_LIMITS.maxListLimit, limit),
    })
    if (!page.ok) {
      return {
        error: page.error,
        scanId: scan.data.scanId,
        selectedCount: scan.data.selectedCount,
      }
    }

    const candidates = page.data.entries.slice(0, limit)
    const read =
      bodiesPerEntry > 0 && candidates.length > 0
        ? await readBodies(
            handlers,
            scan.data.scanId,
            candidates.map((entry) => entry.id),
            args,
          )
        : []

    const texts = new Map(read.map((item) => [item.entryId, item]))
    let withText = 0

    const entries = candidates.map((candidate) => {
      const item = texts.get(candidate.id)
      const text = item?.content?.trim() ?? ""
      const excerpt = text ? text.slice(0, bodiesPerEntry) : null
      if (excerpt) withText += 1

      return {
        id: candidate.id,
        title: candidate.title,
        url: candidate.url,
        feedId: candidate.feedId,
        publishedAt: candidate.publishedAt,
        source: candidate.source,
        contentSource: item?.contentSource ?? null,
        completeness: item?.completeness ?? "unknown",
        excerpt,
        ...(excerpt && text.length > excerpt.length ? { excerptTruncated: true } : {}),
        ...(item?.error ? { error: item.error } : {}),
      }
    })

    return {
      window: range
        ? { name: args.window, from: range.from.toISOString(), to: range.to.toISOString() }
        : null,
      scope,
      counts: {
        matched: scan.data.selectedCount,
        listed: entries.length,
        withText,
        withoutText: entries.length - withText,
      },
      enumerationComplete: scan.data.enumerationComplete,
      sources: scan.data.sources.map((source) => ({
        kind: source.kind,
        id: source.id,
        label: source.label,
        status: source.status,
      })),
      entries,
    }
  }

/** Reads the entries' text in the batches the service accepts, one answer per batch. */
const readBodies = async (
  handlers: LocalAgentReadingToolHandlers,
  scanId: string,
  entryIds: string[],
  args: LocalAIDigestArgs,
): Promise<LocalAgentReadingContentsResult["items"]> => {
  const items: LocalAgentReadingContentsResult["items"] = []

  for (const batch of inBatches(entryIds, LOCAL_AGENT_READING_LIMITS.maxContentBatch)) {
    const read = await handlers.getContents({
      scanId,
      entryIds: batch,
      mode: args.mode ?? "cached",
    })
    // A batch that cannot be read at all still leaves the other entries worth naming.
    if (read.ok) {
      items.push(...capContents(read.data, LOCAL_AI_DIGEST_LIMITS.resultChars).items)
    }
  }

  return items
}

export const createFoloReadingTools = (
  handlers: LocalAgentReadingToolHandlers,
  options: { now?: () => number } = {},
): ToolSet => ({
  folo_get_status: tool({
    description: LOCAL_AGENT_READING_TOOL_INFO.folo_get_status.description,
    // No arguments: the contract has none, and an empty object keeps providers that insist on a
    // schema satisfied.
    inputSchema: jsonSchema<Record<string, never>>({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    execute: () => handlers.status(),
  }),

  folo_begin_unread_scan: tool({
    description: LOCAL_AGENT_READING_TOOL_INFO.folo_begin_unread_scan.description,
    inputSchema: localAgentReadingBeginScanArgsSchema,
    execute: async (args) => answer(await handlers.beginScan(args)),
  }),

  folo_list_scan_entries: tool({
    description: LOCAL_AGENT_READING_TOOL_INFO.folo_list_scan_entries.description,
    inputSchema: localAgentReadingListArgsSchema,
    execute: async (args) => answer(await handlers.listEntries(args)),
  }),

  folo_get_entry_contents: tool({
    description: LOCAL_AGENT_READING_TOOL_INFO.folo_get_entry_contents.description,
    inputSchema: localAgentReadingContentsArgsSchema,
    execute: async (args) => {
      const read = await handlers.getContents(args)
      if (!read.ok) return { error: read.error }
      return capContents(read.data, LOCAL_AI_DIGEST_LIMITS.resultChars)
    },
  }),

  [LOCAL_AI_DIGEST_TOOL_NAME]: tool({
    description: digestDescription,
    inputSchema: localAIDigestArgsSchema,
    execute: createDigest({ handlers, now: options.now ?? Date.now }),
  }),
})

export type FoloReadingToolOptions = Parameters<typeof createFoloReadingTools>[1]
