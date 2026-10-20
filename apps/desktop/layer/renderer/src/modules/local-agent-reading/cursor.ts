/**
 * The enumeration cursor.
 *
 * The renderer is asked for one page at a time and keeps no state between calls: the cursor is the
 * whole state. It therefore carries the fixed source plan of the scan and, per source, how far the
 * pagination got. That is what makes a scan's selection stable while the user reads entries in the
 * app — the plan never grows, and a source is only walked once.
 */
import type { LocalAgentReadingSourceStatus } from "@follow/shared/local-agent-reading"

import type { PlannedSource } from "./types"
import { sourceKey } from "./types"

const CURSOR_PREFIX = "r1"

const SOURCE_KINDS = new Set(["view", "inbox", "feed"])
const SOURCE_STATUSES = new Set<LocalAgentReadingSourceStatus>([
  "complete",
  "partial",
  "failed",
  "unsupported",
  "not_attempted",
])

export interface EnumerationState {
  /** The sources of this scan, in the order they are walked. */
  sources: PlannedSource[]
  /** Source being walked right now. */
  index: number
  /** Pagination cursor inside `sources[index]`; `null` starts that source. */
  position: string | null
  /** Candidates each source contributed, keyed by `sourceKey`. */
  counts: Record<string, number>
  /** Status each source reached, keyed by `sourceKey`. */
  statuses: Record<string, LocalAgentReadingSourceStatus>
  /** Sources whose page boundary may have hidden entries published at the cut time. */
  boundarySources: string[]
}

export const encodeEnumerationCursor = (state: EnumerationState): string =>
  `${CURSOR_PREFIX}.${encodeURIComponent(JSON.stringify(state))}`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const toSource = (value: unknown): PlannedSource | null => {
  if (!isRecord(value)) return null
  const { kind, id } = value
  if (typeof kind !== "string" || !SOURCE_KINDS.has(kind)) return null
  if (typeof id !== "string" || id.length === 0) return null
  return { kind: kind as PlannedSource["kind"], id }
}

/**
 * Parse a cursor this client issued. Anything else — a cursor from another window, a truncated
 * string, a shape a newer version wrote — is refused instead of being guessed at.
 */
export const decodeEnumerationCursor = (cursor: string): EnumerationState | null => {
  const separator = cursor.indexOf(".")
  if (separator !== CURSOR_PREFIX.length || !cursor.startsWith(CURSOR_PREFIX)) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(decodeURIComponent(cursor.slice(separator + 1)))
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null

  const rawSources = parsed["sources"]
  if (!Array.isArray(rawSources)) return null
  const sources: PlannedSource[] = []
  for (const rawSource of rawSources) {
    const source = toSource(rawSource)
    if (!source) return null
    sources.push(source)
  }

  const index = parsed["index"]
  if (
    typeof index !== "number" ||
    !Number.isInteger(index) ||
    index < 0 ||
    index > sources.length
  ) {
    return null
  }

  const position = parsed["position"]
  if (position !== null && typeof position !== "string") return null

  const counts: Record<string, number> = {}
  const rawCounts = parsed["counts"]
  if (rawCounts !== undefined) {
    if (!isRecord(rawCounts)) return null
    for (const [key, value] of Object.entries(rawCounts)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null
      counts[key] = value
    }
  }

  const statuses: Record<string, LocalAgentReadingSourceStatus> = {}
  const rawStatuses = parsed["statuses"]
  if (rawStatuses !== undefined) {
    if (!isRecord(rawStatuses)) return null
    for (const [key, value] of Object.entries(rawStatuses)) {
      if (
        typeof value !== "string" ||
        !SOURCE_STATUSES.has(value as LocalAgentReadingSourceStatus)
      ) {
        return null
      }
      statuses[key] = value as LocalAgentReadingSourceStatus
    }
  }

  const boundarySources: string[] = []
  const rawBoundarySources = parsed["boundarySources"]
  if (rawBoundarySources !== undefined) {
    if (!Array.isArray(rawBoundarySources)) return null
    for (const value of rawBoundarySources) {
      if (typeof value !== "string") return null
      boundarySources.push(value)
    }
  }

  return { sources, index, position, counts, statuses, boundarySources }
}

/** The state a scan starts from: the plan, with nothing walked yet. */
export const createEnumerationState = (sources: PlannedSource[]): EnumerationState => ({
  sources,
  index: 0,
  position: null,
  counts: {},
  statuses: {},
  boundarySources: [],
})

/** Mark the current source as done and move to the next one. */
export const advanceSource = (state: EnumerationState) => {
  state.index += 1
  state.position = null
}

export const currentSource = (state: EnumerationState): PlannedSource | null =>
  state.sources[state.index] ?? null

export const statusOf = (state: EnumerationState, source: PlannedSource) =>
  state.statuses[sourceKey(source)] ?? "not_attempted"

export const setSourceStatus = (
  state: EnumerationState,
  source: PlannedSource,
  status: LocalAgentReadingSourceStatus,
) => {
  state.statuses[sourceKey(source)] = status
}

export const countOf = (state: EnumerationState, source: PlannedSource) =>
  state.counts[sourceKey(source)] ?? 0

export const addToSourceCount = (
  state: EnumerationState,
  source: PlannedSource,
  amount: number,
) => {
  const key = sourceKey(source)
  state.counts[key] = (state.counts[key] ?? 0) + amount
}
