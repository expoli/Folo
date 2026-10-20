/**
 * The data the endpoint reads, and the seam that supplies it.
 *
 * The main process owns the endpoint but not the account data: pagination, de-duplication and
 * content resolution belong to the renderer, which already talks to the account API. This module
 * defines the narrow operations the endpoint needs and implements them over the typed bridge, with
 * a correlation id, a timeout, cancellation and an account check on every answer.
 *
 * The bridge runs code in the renderer, so a call can fail in ways an `await` usually does not:
 * the window may be gone, the renderer may not have registered the handler yet, or the answer may
 * arrive after the caller stopped waiting. All three are reported as named errors instead of
 * undefined data.
 */
import { randomUUID } from "node:crypto"

import { callWindowExpose } from "@follow/shared/bridge"
import type {
  LocalAgentReadingAccountDescription,
  LocalAgentReadingAccountRequest,
  LocalAgentReadingCancelRequest,
  LocalAgentReadingCandidateEntry,
  LocalAgentReadingEntriesRequest,
  LocalAgentReadingEntriesResult,
  LocalAgentReadingEnumerationPage,
  LocalAgentReadingEnumerationRequest,
  LocalAgentReadingProviderError,
  LocalAgentReadingScope,
} from "@follow/shared/local-agent-reading"
import { LOCAL_AGENT_READING_LIMITS } from "@follow/shared/local-agent-reading"
import type { BrowserWindow } from "electron"

/** Renderer side of the bridge, as seen from the main process. */
type RendererExpose = ReturnType<typeof callWindowExpose>

export interface DescribeAccountOptions {
  signal?: AbortSignal
}

export interface EnumerateUnreadRequest {
  accountId: string
  scope: LocalAgentReadingScope
  /** Opaque cursor from the previous page; `null` starts the enumeration. */
  cursor: string | null
  limit: number
  signal?: AbortSignal
}

export interface ResolveEntriesRequest {
  accountId: string
  entryIds: string[]
  includeDetail: boolean
  signal?: AbortSignal
}

/**
 * Everything the endpoint needs from the account.
 *
 * Implementations are supplied by the renderer; the endpoint never reaches an account API directly.
 * A failure is returned, not thrown, so the endpoint can answer with a status the agent can read.
 */
export interface LocalAgentReadingDataProvider {
  describeAccount(options?: DescribeAccountOptions): Promise<LocalAgentReadingAccountDescription>
  enumerateUnread(request: EnumerateUnreadRequest): Promise<LocalAgentReadingEnumerationPage>
  resolveEntries(request: ResolveEntriesRequest): Promise<LocalAgentReadingEntriesResult>
}

export interface RendererDataProviderOptions {
  /** The window whose renderer answers: the main window, never a secondary one. */
  getWindow: () => BrowserWindow | null
  timeoutMs?: number
  log?: (line: string) => void
  /**
   * Injected by the tests: sends one request to the renderer. The default uses the bridge, which
   * evaluates a call in the window and resolves with its answer.
   */
  invoke?: (expose: RendererExpose, request: ProviderRequest) => Promise<unknown>
}

type ProviderMethod =
  | "localAgentReadingDescribeAccount"
  | "localAgentReadingEnumerateUnread"
  | "localAgentReadingResolveEntries"

export interface ProviderRequest {
  method: ProviderMethod
  payload:
    | LocalAgentReadingAccountRequest
    | LocalAgentReadingEnumerationRequest
    | LocalAgentReadingEntriesRequest
}

const appNotReady = (message: string): LocalAgentReadingProviderError => ({
  code: "APP_NOT_READY",
  message,
})

const rendererUnavailable = (message: string): LocalAgentReadingProviderError => ({
  code: "RENDERER_UNAVAILABLE",
  message,
})

/** Sends one request through the bridge; the switch keeps each call fully typed. */
const bridgeInvoke = async (expose: RendererExpose, request: ProviderRequest): Promise<unknown> => {
  switch (request.method) {
    case "localAgentReadingDescribeAccount": {
      return expose.localAgentReadingDescribeAccount(
        request.payload as LocalAgentReadingAccountRequest,
      )
    }
    case "localAgentReadingEnumerateUnread": {
      return expose.localAgentReadingEnumerateUnread(
        request.payload as LocalAgentReadingEnumerationRequest,
      )
    }
    case "localAgentReadingResolveEntries": {
      return expose.localAgentReadingResolveEntries(
        request.payload as LocalAgentReadingEntriesRequest,
      )
    }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

/** Codes a renderer refusal may carry; anything else is an answer this process cannot read. */
const PROVIDER_ERROR_CODES: ReadonlySet<string> = new Set([
  "APP_NOT_READY",
  "ACCOUNT_MISMATCH",
  "CANCELLED",
  "TIMEOUT",
  "INVALID_REQUEST",
  "UPSTREAM_ERROR",
  "RENDERER_UNAVAILABLE",
])

/** A refusal the renderer built itself, as opposed to an answer whose shape is unknown. */
const isProviderError = (value: unknown): value is LocalAgentReadingProviderError =>
  isRecord(value) &&
  typeof value["code"] === "string" &&
  PROVIDER_ERROR_CODES.has(value["code"]) &&
  typeof value["message"] === "string"

/**
 * Provider backed by the renderer bridge.
 *
 * Every call is correlated by a `requestId`, bounded by a timeout, and cancelled on the renderer
 * side when the caller stops waiting. An answer from a different account than the one the main
 * process verified is refused: that is an account switch the scan must not survive.
 */
export const createRendererDataProvider = (
  options: RendererDataProviderOptions,
): LocalAgentReadingDataProvider => {
  const timeoutMs = options.timeoutMs ?? LOCAL_AGENT_READING_LIMITS.providerRequestTimeoutMs
  const invoke = options.invoke ?? bridgeInvoke

  const call = async <T>(
    request: ProviderRequest,
    signal: AbortSignal | undefined,
    acceptedAccountId: string | null,
  ): Promise<{ ok: true; value: T } | { ok: false; error: LocalAgentReadingProviderError }> => {
    const window = options.getWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return { ok: false, error: appNotReady("Folo's window is not open") }
    }

    const expose = callWindowExpose(window)
    const requestId = (request.payload as { requestId: string }).requestId

    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new DOMException("The renderer did not answer in time", "TimeoutError"))
      }, timeoutMs)
    })
    timer?.unref?.()

    const aborted = new Promise<never>((_, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("The request was cancelled", "AbortError"))
        return
      }
      signal?.addEventListener(
        "abort",
        () => reject(new DOMException("The request was cancelled", "AbortError")),
        { once: true },
      )
    })

    const work = invoke(expose, request)

    try {
      const answer = await Promise.race([work, timeout, aborted])
      if (answer === undefined || answer === null) {
        // The renderer has not registered the bridge method (not ready) or the call threw there:
        // the bridge swallows renderer exceptions and answers undefined.
        return {
          ok: false,
          error: appNotReady("The renderer has not registered the reading bridge"),
        }
      }
      if (!isRecord(answer)) {
        return {
          ok: false,
          error: rendererUnavailable("The renderer answered with an unexpected value"),
        }
      }

      const answeredAccount = typeof answer["accountId"] === "string" ? answer["accountId"] : null
      if (acceptedAccountId && answeredAccount && answeredAccount !== acceptedAccountId) {
        return {
          ok: false,
          error: {
            code: "ACCOUNT_MISMATCH",
            message: "The renderer is signed in to another account",
          },
        }
      }
      if (acceptedAccountId && !answeredAccount) {
        // A refusal has no account to name when the renderer has none left — signing out mid-scan
        // is exactly that — so its own typed reason is kept instead of being replaced by "the
        // renderer is unavailable". A data answer must always name its account, or it cannot be
        // bound to the session the main process verified.
        if (answer["ok"] === false && isProviderError(answer["error"])) {
          return { ok: true, value: answer as T }
        }
        // An answer that does not name its account cannot be checked against the session.
        return {
          ok: false,
          error: rendererUnavailable("The renderer answer did not name the account"),
        }
      }

      return { ok: true, value: answer as T }
    } catch (error) {
      // The renderer may still be working on the answer; ask it to stop and drop the result.
      try {
        const cancel: LocalAgentReadingCancelRequest = { requestId }
        expose.localAgentReadingCancel(cancel)
      } catch {
        // A bridge that cannot reach the renderer has nothing left to cancel.
      }
      // The losing promise is not awaited: never let it surface as an unhandled rejection.
      void Promise.resolve(work).catch(() => {})

      const name = error instanceof Error ? error.name : ""
      if (name === "TimeoutError") {
        return {
          ok: false,
          error: { code: "TIMEOUT", message: "The renderer did not answer in time" },
        }
      }
      if (name === "AbortError") {
        return { ok: false, error: { code: "CANCELLED", message: "The request was cancelled" } }
      }

      options.log?.(`[local-agent-reading] renderer call failed: ${String(error)}`)
      return {
        ok: false,
        error: rendererUnavailable(
          error instanceof Error ? error.message : "The renderer call failed",
        ),
      }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async describeAccount(requestOptions: DescribeAccountOptions = {}) {
      const result = await call<LocalAgentReadingAccountDescription>(
        {
          method: "localAgentReadingDescribeAccount",
          payload: { requestId: randomUUID() },
        },
        requestOptions.signal,
        null,
      )

      if (!result.ok) return { ok: false, error: result.error }

      const description = result.value
      if (description.ok !== true || typeof description.accountId !== "string") {
        return {
          ok: false,
          error:
            (description as { error?: LocalAgentReadingProviderError }).error ??
            rendererUnavailable("The renderer did not describe an account"),
        }
      }

      return description
    },

    async enumerateUnread(request: EnumerateUnreadRequest) {
      const result = await call<LocalAgentReadingEnumerationPage>(
        {
          method: "localAgentReadingEnumerateUnread",
          payload: {
            requestId: randomUUID(),
            accountId: request.accountId,
            scope: request.scope,
            cursor: request.cursor,
            limit: request.limit,
          },
        },
        request.signal,
        request.accountId,
      )

      if (!result.ok) return { ok: false, error: result.error }

      const page = result.value
      if (page.ok !== true || !Array.isArray(page.entries)) {
        return {
          ok: false,
          error:
            (page as { error?: LocalAgentReadingProviderError }).error ??
            rendererUnavailable("The renderer did not return an enumeration page"),
        }
      }

      // A candidate whose shape cannot be read is a broken answer, not a chance to drop rows.
      if (!page.entries.every(isCandidateEntry)) {
        return {
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: "The renderer returned an enumeration entry that cannot be read",
          },
        }
      }

      return page
    },

    async resolveEntries(request: ResolveEntriesRequest) {
      const result = await call<LocalAgentReadingEntriesResult>(
        {
          method: "localAgentReadingResolveEntries",
          payload: {
            requestId: randomUUID(),
            accountId: request.accountId,
            entryIds: request.entryIds,
            includeDetail: request.includeDetail,
          },
        },
        request.signal,
        request.accountId,
      )

      if (!result.ok) return { ok: false, error: result.error }

      const resolved = result.value
      if (resolved.ok !== true || !Array.isArray(resolved.entries)) {
        return {
          ok: false,
          error:
            (resolved as { error?: LocalAgentReadingProviderError }).error ??
            rendererUnavailable("The renderer did not return entry contents"),
        }
      }

      return resolved
    },
  }
}

const isCandidateEntry = (value: unknown): value is LocalAgentReadingCandidateEntry =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  (value["readState"] === "unread" || value["readState"] === "unknown")
