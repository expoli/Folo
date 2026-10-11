import type { LocalAIDirectConfig } from "@follow/shared/settings/local-ai"
import { LOCAL_AI_DIRECT_ORIGIN } from "@follow/shared/settings/local-ai"

import { handleConfig, handleHealth } from "./config"
import { jsonResponse, parseJsonBody } from "./http"
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

  try {
    if (method === "POST" && pathname === "/ai/summary") {
      return await handleSummaryRequest({
        body: parseJsonBody(input.body),
        model: createDirectModel({ config, apiKey, fetch }),
        call,
      })
    }

    if (method === "POST" && pathname === "/ai/summary-title") {
      return await handleSummaryTitleRequest({
        body: parseJsonBody(input.body),
        model: createDirectModel({ config, apiKey, fetch }),
        call,
      })
    }

    if (method === "POST" && pathname === "/ai/translation/batch") {
      return await handleTranslationBatchRequest({
        body: parseJsonBody(input.body),
        model: createDirectModel({ config, apiKey, fetch }),
        call,
      })
    }
  } catch (error) {
    // An unreadable body or a missing model is a request problem, so report it as one.
    console.error("[local-ai] request failed:", error)
    return jsonResponse(400, {
      error: error instanceof Error ? error.message : "Local AI request failed",
    })
  }

  return null
}
