/**
 * How a failed account request is described to the agent.
 *
 * The account client puts the request arguments — its headers, including the session cookie —
 * into its error message, and these strings end up in the scan errors and the per-entry content
 * errors an external agent reads. Only the status code is kept; the message itself never leaves
 * this process.
 */
import { FollowAPIError } from "@follow-app/client-sdk"

export const requestFailureMessage = (error: unknown): string => {
  if (error instanceof FollowAPIError) {
    return `The account API answered HTTP ${error.status}`
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "The request was cancelled"
  }

  return "The account API request failed"
}
