import type { LocalAIDirectConfig } from "@follow/shared/settings/local-ai"
import { LOCAL_AI_DIRECT_ORIGIN } from "@follow/shared/settings/local-ai"

import { handleConfig, handleHealth } from "./config"
import { errorMessage, statusForError } from "./errors"
import { jsonResponse, parseJsonBody } from "./http"
import type { LanguageModelFactory } from "./provider"
import { createDirectModel, directCallOptions } from "./provider"
import { handleSummaryRequest } from "./summary"
import { handleSummaryTitleRequest } from "./title"
import { handleTranslationBatchRequest } from "./translation"

export interface DirectRouteInput {
  /** Request path, may carry a query string. The origin is ignored. */
  path: string
  method: string
  /** Request body as sent by the AI SDK; `null` for requests without one. */
  body: string | null
  config: LocalAIDirectConfig
  /** API key from the platform's credential store; `null` when the user has not saved one. */
  apiKey: string | null
  /**
   * Transport of the platform: the desktop main process passes Chromium's network stack, the
   * mobile app passes its own runtime's fetch.
   */
  fetch: typeof globalThis.fetch
  /**
   * Provider of one request. The direct mode leaves it out (the OpenAI-compatible factory is the
   * default); a platform that speaks another protocol injects its own.
   */
  createModel?: LanguageModelFactory
  /** Receives one line per failure; the calling app prefixes it with its own name. */
  log?: (line: string) => void
}

const probeRequested = (path: string) => {
  const { searchParams } = new URL(path, LOCAL_AI_DIRECT_ORIGIN)
  const probe = searchParams.get("probe")
  return probe === "1" || probe === "true"
}

/**
 * Answers the paths of the direct contract that every platform shares: health, the model
 * catalogue, summary, summary title and translation. Returns `null` for a path it does not own
 * (chat has a streaming transport of its own, so the calling app dispatches those paths first).
 *
 * A failure is answered with the status it deserves: 400 for input the runtime cannot use, 502 for
 * an upstream/provider failure, 500 for anything unexpected — never a blanket 400.
 */
export const routeLocalAIRequest = async (input: DirectRouteInput): Promise<Response | null> => {
  const { pathname } = new URL(input.path, LOCAL_AI_DIRECT_ORIGIN)
  const method = input.method.toUpperCase()
  const { config, apiKey, fetch } = input
  // The settings travel with every request, so a change applies to the next call without a restart.
  const call = directCallOptions(config)

  if (method === "GET" && pathname === "/health") {
    return handleHealth(config, apiKey, probeRequested(input.path), fetch)
  }

  if (method === "GET" && pathname === "/ai/chat/config") {
    return handleConfig(config, apiKey, fetch)
  }

  const createModel = input.createModel ?? createDirectModel
  // Set once the model exists: from there on, a failure is the model call's, not the request's.
  let upstream = false

  try {
    if (method === "POST" && pathname === "/ai/summary") {
      const model = createModel({ config, apiKey, fetch })
      upstream = true

      return await handleSummaryRequest({ body: parseJsonBody(input.body), model, call })
    }

    if (method === "POST" && pathname === "/ai/summary-title") {
      const model = createModel({ config, apiKey, fetch })
      upstream = true

      return await handleSummaryTitleRequest({
        body: parseJsonBody(input.body),
        model,
        call,
        log: input.log,
      })
    }

    if (method === "POST" && pathname === "/ai/translation/batch") {
      const model = createModel({ config, apiKey, fetch })
      upstream = true

      return await handleTranslationBatchRequest({
        body: parseJsonBody(input.body),
        model,
        call,
        log: input.log,
      })
    }
  } catch (error) {
    const status = statusForError(error, { upstream })
    input.log?.(
      `${method} ${pathname} failed (${status}): ${errorMessage(error, "request failed")}`,
    )
    return jsonResponse(status, { error: errorMessage(error, "Local AI request failed") })
  }

  return null
}
