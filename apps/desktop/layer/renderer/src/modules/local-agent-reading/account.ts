/**
 * What the app can answer about the signed-in account.
 *
 * The endpoint re-checks this on every tool call, so signing out, switching accounts and a window
 * that has not finished loading are all reported the same way: the scan is refused instead of being
 * served from a stale view of the account.
 *
 * `syncedAt` is `null`: the client keeps a change-log cursor for incremental sync, not the time of
 * the last successful sync, and inventing one would overstate how fresh the data is.
 */
import type {
  LocalAgentReadingAccountDescription,
  LocalAgentReadingSourceCapability,
} from "@follow/shared/local-agent-reading"

import { buildPlan, isSupportedSource } from "./plan"
import type { LocalAgentReadingDeps } from "./types"

export const describeAccount = async (
  deps: LocalAgentReadingDeps,
): Promise<LocalAgentReadingAccountDescription> => {
  const accountId = deps.getAccountId()
  if (!accountId) {
    // No session yet, or the app is not signed in at all: nothing about the account can be
    // promised, and the main process reports it as "the app is not ready".
    return { ok: false, error: { code: "APP_NOT_READY", message: "Folo is not signed in" } }
  }

  const sources: LocalAgentReadingSourceCapability[] = buildPlan(undefined, deps).map((source) => ({
    kind: source.kind,
    id: source.id,
    label: deps.getSourceLabel(source),
    status: isSupportedSource(source) ? "complete" : "unsupported",
  }))

  return { ok: true, accountId, ready: true, syncedAt: null, sources }
}
