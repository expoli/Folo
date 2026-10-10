import type { LanguageModel } from "ai"
import { generateText } from "ai"

import { jsonResponse } from "./http"
import { DEFAULT_TITLE_SYSTEM_PROMPT } from "./prompts"

/**
 * `POST /ai/summary-title`: Folo's server writes a short title for a chat; with a local model the
 * main process asks the same model instead, so the "generate title" action needs no Folo API.
 */
export const TITLE_MAX_OUTPUT_TOKENS = 32

/** Model replies quote and punctuate titles; the UI shows whatever comes back verbatim. */
export const cleanTitle = (text: unknown) => {
  const source = typeof text === "string" ? text.trim() : ""
  const firstLine = source.split("\n")[0] ?? ""

  return firstLine
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/[.。！!？?]+$/g, "")
    .trim()
    .slice(0, 80)
}

export const handleSummaryTitleRequest = async (params: {
  body: Record<string, unknown>
  model: LanguageModel
}) => {
  const messages = Array.isArray(params.body.messages) ? params.body.messages : []
  const transcript = messages
    .map((message) => {
      const entry = message as { role?: unknown; content?: unknown }
      const role = typeof entry?.role === "string" ? entry.role : "user"
      const content = typeof entry?.content === "string" ? entry.content : ""

      return `${role}: ${content}`
    })
    .join("\n")
    .trim()
    .slice(0, 4000)

  if (!transcript) {
    return jsonResponse(400, { error: "Field `messages` is required" })
  }

  const { text } = await generateText({
    model: params.model,
    system: DEFAULT_TITLE_SYSTEM_PROMPT,
    prompt: transcript,
    maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
  })

  return jsonResponse(200, { title: cleanTitle(text) })
}
