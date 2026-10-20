/**
 * The renderer side of the bridge the main process calls.
 *
 * Every method answers with a value and never throws: the bridge that reaches the main process
 * swallows an exception and reports "the renderer is not ready", which would look like a signed-out
 * app instead of a failure. Each answer also names the account it was produced for, so the main
 * process can refuse an answer that belongs to an account the user just left.
 */
import type {
  LocalAgentReadingBridge,
  LocalAgentReadingProviderError,
} from "@follow/shared/local-agent-reading"

import { describeAccount } from "./account"
import { cancelActiveRequest, runCancellable } from "./cancel"
import { enumerateUnreadPage } from "./enumerate"
import { requestFailureMessage } from "./failure"
import { resolveEntryContents } from "./resolve"
import type { LocalAgentReadingDeps } from "./types"

const unavailable = (error: unknown): LocalAgentReadingProviderError => ({
  code: "RENDERER_UNAVAILABLE",
  message: requestFailureMessage(error),
})

export const createLocalAgentReadingBridge = (
  deps: LocalAgentReadingDeps,
): LocalAgentReadingBridge => ({
  async localAgentReadingDescribeAccount(request) {
    try {
      return await runCancellable(request.requestId, () => describeAccount(deps))
    } catch (error) {
      console.error("[local-agent-reading] describeAccount failed", error)
      return { ok: false, error: unavailable(error) }
    }
  },

  async localAgentReadingEnumerateUnread(request) {
    try {
      return await runCancellable(request.requestId, (signal) =>
        enumerateUnreadPage(deps, request, signal),
      )
    } catch (error) {
      console.error("[local-agent-reading] enumerateUnread failed", error)
      return { ok: false, error: unavailable(error) }
    }
  },

  async localAgentReadingResolveEntries(request) {
    try {
      return await runCancellable(request.requestId, (signal) =>
        resolveEntryContents(deps, request, signal),
      )
    } catch (error) {
      console.error("[local-agent-reading] resolveEntries failed", error)
      return { ok: false, error: unavailable(error) }
    }
  },

  localAgentReadingCancel(request) {
    cancelActiveRequest(request.requestId)
  },
})
