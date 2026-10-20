/**
 * Account identity the endpoint serves.
 *
 * Sessions live in the main process (Chromium's cookie jar), so the main process — not the
 * renderer, and certainly not the agent — decides which account a scan belongs to. A session that
 * cannot be checked is reported as `unknown`, never as signed out and never as "no unread entries".
 */
import { FollowAPIError } from "@follow-app/client-sdk"

import { apiClient } from "../lib/api-client"

export type LocalAgentReadingAccountResolution =
  | { kind: "signed-in"; accountId: string; checkedAt: string }
  | { kind: "signed-out"; checkedAt: string }
  | { kind: "unknown"; checkedAt: string; reason: string }

export type LocalAgentReadingAccountResolver = () => Promise<LocalAgentReadingAccountResolution>

/**
 * A short reason that is safe to show an agent.
 *
 * The account client's error message carries the request arguments — its headers, including the
 * session cookie — and this reason reaches the agent in the `ACCOUNT_UNAVAILABLE` refusal. Only
 * the status code is kept.
 */
const reasonOf = (error: unknown): string => {
  if (error instanceof FollowAPIError) return `the session API answered HTTP ${error.status}`

  return "the session API could not be reached"
}

/**
 * Asks the session API which user the app is signed in as.
 *
 * Only a 401 means signed out; a timeout or a server error means the account cannot be confirmed
 * right now, which is a different answer and stays visible as such.
 */
export const resolveSessionAccount: LocalAgentReadingAccountResolver = async () => {
  const checkedAt = new Date().toISOString()

  try {
    const session = await apiClient.auth.getSession()
    const accountId = session?.user?.id
    if (!accountId) return { kind: "signed-out", checkedAt }

    return { kind: "signed-in", accountId, checkedAt }
  } catch (error) {
    if (error instanceof FollowAPIError && error.status === 401) {
      return { kind: "signed-out", checkedAt }
    }

    return { kind: "unknown", checkedAt, reason: reasonOf(error) }
  }
}
