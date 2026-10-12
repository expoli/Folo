import { APICallError } from "ai"

/**
 * Errors of the local AI contract, typed so a router can answer with the right HTTP status.
 *
 * Before this existed every failure of the runtime travelled as a plain `Error` and the caller
 * answered 400, which read as "your request was wrong" even when the model endpoint was the
 * problem. A caller that does not care can keep reading `message`.
 */
export class LocalAIRequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "LocalAIRequestError"
    this.status = status
  }
}

/** Input the runtime cannot work with: a missing field, an unreadable body, no model configured. */
export const badRequest = (message: string) => new LocalAIRequestError(400, message)

/** The endpoint answered with an error (rejected key, rate limit, upstream model failure). */
export const upstreamFailure = (message: string) => new LocalAIRequestError(502, message)

const upstreamStatus = (error: unknown) => {
  if (error instanceof APICallError) return error.statusCode
  if (!error || typeof error !== "object") return undefined

  // Provider errors that do not come from the AI SDK still carry the upstream status.
  const status = (error as { statusCode?: unknown; status?: unknown }).statusCode
  if (typeof status === "number") return status
  const { status: plainStatus } = error as { status?: unknown }

  return typeof plainStatus === "number" ? plainStatus : undefined
}

/**
 * Nothing about a provider error is a request problem: the input was accepted and the model call
 * is what failed, so it is reported as a bad upstream (502) with the message the provider sent.
 */
export const isUpstreamError = (error: unknown) => {
  if (error instanceof APICallError) return true

  const status = upstreamStatus(error)
  return status !== undefined && status >= 400
}

/**
 * The status a failed local AI request answers with.
 *
 * A typed error keeps its own status (bad input stays 400). When the caller says the failure
 * happened while the model was answering (`upstream`), the request itself was fine, so it is
 * reported as a bad upstream — a provider that fails without a status code is still a provider
 * failure, not an internal one.
 */
export const statusForError = (error: unknown, options: { upstream?: boolean } = {}): number => {
  if (error instanceof LocalAIRequestError) return error.status
  if (options.upstream || isUpstreamError(error)) return 502

  return 500
}

/** Human-readable reason of a failure, in the words the provider used when there are any. */
export const errorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message.trim()) {
    if (error instanceof LocalAIRequestError) return error.message

    const status = upstreamStatus(error)
    return isUpstreamError(error) && status && !error.message.includes(String(status))
      ? `${error.message} (upstream ${status})`
      : error.message
  }

  return error === undefined || error === null ? fallback : String(error)
}
