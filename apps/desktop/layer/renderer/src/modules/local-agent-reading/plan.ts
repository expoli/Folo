/**
 * Which parts of the account a scan covers.
 *
 * The plan is drawn once, when the scan starts, from the scope the agent asked for: every
 * subscribed timeline view and every inbox by default, or exactly the views / feeds / inboxes it
 * named. Views are paged through the account API rather than through a local list, so an entry the
 * user never opened is still found; the search results and archived entries the shared contract
 * lists as unsupported are reported as such instead of being silently left out.
 */
import type { LocalAgentReadingScope } from "@follow/shared/local-agent-reading"
import { LOCAL_AGENT_READING_VIEWS } from "@follow/shared/local-agent-reading"

import type { PlannedSource } from "./types"
import { sourceKey } from "./types"

/** `FeedViewType.All`: asking for "all" means every view the contract lists. */
const ALL_VIEWS_VALUE = -1

const SUPPORTED_VIEWS: number[] = LOCAL_AGENT_READING_VIEWS.map((view) => view.value)

const unique = <T>(values: T[]): T[] => [...new Set(values)]

/**
 * True when the plan may page this source. A view number this build does not know (a future
 * timeline) is reported as unsupported by the enumeration instead of being skipped.
 */
export const isSupportedSource = (source: PlannedSource) => {
  if (source.kind !== "view") return true
  return SUPPORTED_VIEWS.includes(Number(source.id))
}

export const viewLabel = (id: string) =>
  LOCAL_AGENT_READING_VIEWS.find((view) => String(view.value) === id)?.label ?? null

/**
 * The views a scan asks for. `-1` ("all") means every view the contract lists; a view number this
 * build does not know is kept in the plan so the enumeration can report it as unsupported instead
 * of leaving it out silently.
 */
const requestedViews = (views: number[]): number[] =>
  views.includes(ALL_VIEWS_VALUE) ? [...SUPPORTED_VIEWS] : unique(views)

/**
 * The sources of a scan, in the order they are walked. The default is the whole account; any field
 * of the scope narrows it. Feeds and inboxes are de-duplicated by id, so naming one twice (or a
 * feed that is also a subscription of a view) never pages the same source twice.
 */
export const buildPlan = (
  scope: LocalAgentReadingScope | undefined,
  deps: { listInboxIds: () => string[] },
): PlannedSource[] => {
  const feedIds = unique(scope?.feedIds ?? [])
  const inboxIds = unique(scope?.inboxIds ?? [])
  const narrowed = (scope?.views?.length ?? 0) > 0 || feedIds.length > 0 || inboxIds.length > 0

  const views = scope?.views?.length ? requestedViews(scope.views) : narrowed ? [] : SUPPORTED_VIEWS
  // Without an explicit inbox list, a narrowed scan stays narrowed instead of pulling in every
  // inbox of the account.
  const inboxes = inboxIds.length > 0 ? inboxIds : narrowed ? [] : unique(deps.listInboxIds())

  const sources: PlannedSource[] = [
    ...views.map((view) => ({ kind: "view" as const, id: String(view) })),
    ...feedIds.map((feedId) => ({ kind: "feed" as const, id: feedId })),
    ...inboxes.map((inboxId) => ({ kind: "inbox" as const, id: inboxId })),
  ]

  const seen = new Set<string>()
  const plan = sources.filter((source) => {
    const key = sourceKey(source)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  // An account with nothing to page still answers with one source per view, so a scan reports
  // "complete, nothing unread" instead of an empty plan that looks like an unfinished walk.
  return plan.length > 0
    ? plan
    : SUPPORTED_VIEWS.map((view) => ({ kind: "view" as const, id: String(view) }))
}
