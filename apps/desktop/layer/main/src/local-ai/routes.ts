import type { LocalAIDirectConfig } from "@follow/shared/settings/local-ai"
import { LOCAL_AI_DIRECT_ORIGIN } from "@follow/shared/settings/local-ai"
import {
  fetchUpstreamModelIds as fetchUpstreamModelIdsShared,
  handleConfig as handleConfigShared,
  handleHealth as handleHealthShared,
  parseModelIds,
  resetModelListCache,
} from "@follow/store/ai-local/direct/config"
import { routeLocalAIRequest as routeSharedLocalAIRequest } from "@follow/store/ai-local/direct/routes"

import { createChatStreamResponse, createStreamResumeResponse } from "./chat"
import { jsonResponse, netFetch, parseJsonBody } from "./http"

export { parseModelIds, resetModelListCache }

/** Paths that only the desktop app answers; the rest comes from the shared direct-mode core. */
const CHAT_STREAM_PATH = /^\/ai\/chat\/[^/]+\/stream$/

export interface LocalAIRouteInput {
  /** Request path, may carry a query string. The origin is ignored. */
  path: string
  method: string
  /** Request body as sent by the AI SDK; `null` for requests without one. */
  body: string | null
  config: LocalAIDirectConfig
  /** API key from the encrypted store; `null` when the user has not saved one. */
  apiKey: string | null
}

export const fetchUpstreamModelIds = (config: LocalAIDirectConfig, apiKey: string | null) =>
  fetchUpstreamModelIdsShared(config, apiKey, netFetch)

export const handleConfig = (config: LocalAIDirectConfig, apiKey: string | null) =>
  handleConfigShared(config, apiKey, netFetch)

export const handleHealth = (config: LocalAIDirectConfig, apiKey: string | null, probe: boolean) =>
  handleHealthShared(config, apiKey, probe, netFetch)

/** Dispatches one path of the local AI contract; every other path answers 404. */
export const routeLocalAIRequest = async (input: LocalAIRouteInput): Promise<Response> => {
  const { pathname } = new URL(input.path, LOCAL_AI_DIRECT_ORIGIN)
  const method = input.method.toUpperCase()

  // Chat streams over IPC instead of a fetch response, so it is answered before the shared core.
  if (method === "GET" && CHAT_STREAM_PATH.test(pathname)) {
    return createStreamResumeResponse()
  }

  if (method === "POST" && pathname === "/ai/chat") {
    return await createChatStreamResponse({
      body: parseJsonBody(input.body),
      config: input.config,
      apiKey: input.apiKey,
    })
  }

  const handled = await routeSharedLocalAIRequest({ ...input, fetch: netFetch })
  if (handled) return handled

  return jsonResponse(404, { error: `Unsupported endpoint: ${method} ${pathname}` })
}
