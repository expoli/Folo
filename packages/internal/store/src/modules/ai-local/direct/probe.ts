import type { LocalAIDirectConfig } from "@follow/shared/settings/local-ai"
import { generateText } from "ai"

import { createDirectModel } from "./provider"

/** One minimal model call, so the settings UI can tell "endpoint up" from "model answers". */
export const probeDirectModel = async (params: {
  config: LocalAIDirectConfig
  apiKey: string | null
  fetch: typeof globalThis.fetch
}) => {
  const startedAt = Date.now()

  try {
    await generateText({
      model: createDirectModel(params),
      prompt: "ping",
      maxOutputTokens: 1,
      // A probe reports the state right now; the SDK's retries would only make the user wait.
      maxRetries: 0,
    })

    return { ok: true as const, latencyMs: Date.now() - startedAt }
  } catch (error) {
    return {
      ok: false as const,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
