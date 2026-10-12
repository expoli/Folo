import type { LanguageModel } from "ai"
import { generateText } from "ai"

import { jsonResponse } from "./http"
import { MAX_OUTPUT_TOKENS } from "./limits"
import { DEFAULT_TITLE_SYSTEM_PROMPT, languageName } from "./prompts"
import type { DirectCallOptions } from "./provider"

/**
 * `POST /ai/summary-title`: Folo's server writes a short title for a chat; with a local model the
 * app (or the gateway) asks the same model instead, so the "generate title" action needs no Folo
 * API.
 */

/**
 * First words of the conversation, used when the model returns no text at all: a button that does
 * nothing is worse than a title taken from the answer it just wrote.
 */
export const fallbackTitle = (messages: unknown[]): string => {
  const texts = messages
    .map((message) => {
      const content = (message as { content?: unknown })?.content
      return typeof content === "string" ? content.trim() : ""
    })
    .filter(Boolean)

  // Shortcut templates are long English prompts, so a short message makes the better title.
  const answer = texts.at(-1) ?? ""
  const source = texts.find((text) => text.length <= 80) ?? answer

  return (source.split("\n")[0] ?? "").slice(0, 60).trim()
}

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
  call?: DirectCallOptions
  /** Wording of the title prompt; the gateway lets its environment replace it. */
  systemPrompt?: string
  /** Receives one line per request; the calling app prefixes it with its own name. */
  log?: (line: string) => void
}) => {
  const { body, model, call, systemPrompt, log } = params
  const messages = Array.isArray(body.messages) ? body.messages : []
  const language = typeof body.language === "string" ? body.language : null
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

  const { text, reasoning, finishReason, usage } = await generateText({
    model,
    system: [
      systemPrompt ?? DEFAULT_TITLE_SYSTEM_PROMPT,
      language ? `Write the title in ${languageName(language)}.` : "",
    ]
      .filter(Boolean)
      .join(" "),
    prompt: transcript,
    // The same budget as every other call: it is a ceiling, not a target, and a smaller one would
    // only cut a reasoning model off before it writes the title.
    maxOutputTokens: call?.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
    temperature: call?.temperature,
    providerOptions: call?.providerOptions,
  })

  const generated = cleanTitle(text)
  const title = generated || fallbackTitle(messages)
  // The UI reports a failure when no title comes back, so the log says which case it was: a model
  // that spent its budget thinking, a provider that answers in `reasoning` only, or nothing at all.
  log?.(
    `title: ${title ? JSON.stringify(title) : "(empty reply)"}${
      generated
        ? ""
        : ` (fallback) finish=${finishReason ?? "?"} output=${usage?.outputTokens ?? "?"} reasoning=${
            usage?.outputTokenDetails?.reasoningTokens ?? "?"
          } reasoningText=${reasoning?.length ?? 0}`
    }`,
  )

  return jsonResponse(200, { title })
}
