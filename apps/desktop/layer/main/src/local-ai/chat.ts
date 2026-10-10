import type { LocalAIDirectConfig } from "@follow/shared/settings/local-ai"
import { generateText, streamText } from "ai"

import type { LocalAIContext } from "./context"
import {
  buildChatSystemPrompt,
  describeChatContext,
  formatLocalContext,
  toModelMessages,
} from "./context"
import { jsonResponse } from "./http"
import { DEFAULT_CHAT_SYSTEM_PROMPT } from "./prompts"
import { createDirectModel, directCallOptions } from "./provider"

interface ChatRequestBody {
  messages?: unknown
  model?: unknown
  localAIContext?: LocalAIContext
  /** Interface language of the app, so the answer matches it instead of the prompt's language. */
  language?: unknown
}

/**
 * Answers `POST /ai/chat` with an AI SDK UI message stream, the same shape `HttpChatTransport`
 * expects from Folo's own API and from a self-hosted gateway.
 */
export const createChatStreamResponse = (params: {
  body: ChatRequestBody
  config: LocalAIDirectConfig
  apiKey: string | null
  abortSignal?: AbortSignal
}): Response => {
  const { body, config, apiKey, abortSignal } = params
  const messages = toModelMessages(body.messages)
  if (messages.length === 0) {
    return jsonResponse(400, { error: "No message text found in the request" })
  }

  const localContext = formatLocalContext(body.localAIContext)
  const stats = describeChatContext(body.localAIContext)
  const requestedModel = typeof body.model === "string" ? body.model : null
  const call = directCallOptions(config)

  console.log(
    `[local-ai] chat: model=${requestedModel ?? config.model} messages=${messages.length} ` +
      `context=${stats.blocks} block(s)/${stats.entries} entrie(s)(${stats.withText} with text)/` +
      `${stats.matched} matched/window=${stats.window || "none"}/${stats.feeds} feed(s)/${
        stats.contextChars
      } chars${stats.selection ? ` [${stats.selection}]` : ""}`,
  )
  if (localContext === "") {
    console.warn(
      "[local-ai] chat: no localAIContext arrived, so the model cannot see the Folo entries " +
        "(the client attaches them only when local AI is enabled and the chat has context blocks)",
    )
  }

  let model
  try {
    model = createDirectModel({ config, apiKey, requestedModel })
  } catch (error) {
    return jsonResponse(400, { error: error instanceof Error ? error.message : String(error) })
  }

  const result = streamText({
    model,
    system: buildChatSystemPrompt(
      DEFAULT_CHAT_SYSTEM_PROMPT,
      localContext,
      typeof body.language === "string" ? body.language : null,
    ),
    messages,
    maxOutputTokens: call.maxOutputTokens,
    temperature: call.temperature,
    providerOptions: call.providerOptions,
    abortSignal,
    // Reasoning models answer only after thinking, and a cap their thinking uses up leaves an empty
    // reply; this line says which of the two happened.
    onFinish: ({ finishReason, usage }) => {
      console.log(
        `[local-ai] chat done: finish=${finishReason ?? "?"} output=${usage?.outputTokens ?? "?"} ` +
          `reasoning=${usage?.outputTokenDetails?.reasoningTokens ?? "?"}`,
      )
    },
  })

  return result.toUIMessageStreamResponse({
    sendReasoning: true,
    onError: (error) => {
      console.error("[local-ai] chat stream error:", error)
      return error instanceof Error ? error.message : "Local AI error"
    },
  })
}

/** `GET /ai/chat/:id/stream` has no server-side history to resume; always "no active stream". */
export const createStreamResumeResponse = () => new Response(null, { status: 204 })

/** One minimal model call, so the settings UI can tell "endpoint up" from "model answers". */
export const probeDirectModel = async (params: {
  config: LocalAIDirectConfig
  apiKey: string | null
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
