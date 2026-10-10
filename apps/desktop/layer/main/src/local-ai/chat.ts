import type { LocalAIDirectConfig } from "@follow/shared/settings/local-ai"
import { generateText, streamText } from "ai"

import type { LocalAIContext } from "./context"
import {
  applyEntryNotes,
  buildChatSystemPrompt,
  describeChatContext,
  formatLocalContext,
  pendingEntryTexts,
  toModelMessages,
} from "./context"
import { jsonResponse } from "./http"
import { DEFAULT_CHAT_SYSTEM_PROMPT } from "./prompts"
import { createDirectModel, directCallOptions, resolveModelId } from "./provider"
import type { NotesCache } from "./reduce"
import { summarizeEntries } from "./reduce"

/** Longest note attached per article, and for all notes together: the prompt still has a size. */
const NOTES_ENTRY_CHARS = 600
const NOTES_TOTAL_CHARS = 30_000

/**
 * Notes of earlier summaries, so running the same one again costs nothing.
 *
 * Kept for the life of the process and pruned oldest first; a warmer cache would have to be
 * persisted (and invalidated per model, language and article), which is its own piece of work.
 */
const notesCache = new Map<string, string>()
const NOTES_CACHE_LIMIT = 2000

const noteCache: NotesCache = {
  get: (key) => notesCache.get(key),
  set: (key, value) => {
    notesCache.set(key, value)
    while (notesCache.size > NOTES_CACHE_LIMIT) {
      const oldest = notesCache.keys().next().value
      if (oldest === undefined) break
      notesCache.delete(oldest)
    }
  },
}

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
export const createChatStreamResponse = async (params: {
  body: ChatRequestBody
  config: LocalAIDirectConfig
  apiKey: string | null
  abortSignal?: AbortSignal
}): Promise<Response> => {
  const { body, config, apiKey, abortSignal } = params
  const messages = toModelMessages(body.messages)
  if (messages.length === 0) {
    return jsonResponse(400, { error: "No message text found in the request" })
  }

  const stats = describeChatContext(body.localAIContext)
  const requestedModel = typeof body.model === "string" ? body.model : null
  const language = typeof body.language === "string" ? body.language : null
  const call = directCallOptions(config)

  console.log(
    `[local-ai] chat: model=${requestedModel ?? config.model} messages=${messages.length} ` +
      `context=${stats.blocks} block(s)/${stats.entries} entrie(s)(${stats.withText} with text + ` +
      `${stats.reduceTexts} for reduce)/${stats.matched} matched/window=${stats.window || "none"}/${
        stats.feeds
      } feed(s)/${stats.contextChars} chars${stats.selection ? ` [${stats.selection}]` : ""}`,
  )

  let model
  try {
    model = createDirectModel({ config, apiKey, requestedModel })
  } catch (error) {
    return jsonResponse(400, { error: error instanceof Error ? error.message : String(error) })
  }

  // A selection too wide for the prompt arrives with the texts of the extra articles; summarize
  // them first, so the answer covers the whole selection instead of its first twenty articles.
  let context = body.localAIContext ?? null
  const pending = pendingEntryTexts(context)
  if (pending.length > 0) {
    const startedAt = Date.now()
    console.log(
      `[local-ai] reduce: summarizing ${pending.length} article(s) the prompt cannot carry…`,
    )
    const reduced = await summarizeEntries({
      model,
      entries: pending,
      language,
      call,
      cache: noteCache,
      // The model that actually runs, not the one the client asked for: a requested model outside
      // the configured list silently falls back, and its notes must not be reused as the other's.
      modelId: resolveModelId(config, requestedModel) || requestedModel || config.model,
      log: console.log,
      signal: abortSignal,
    })

    // The notes are attached in the order of the entries (the more relevant ones first), so a day
    // too wide even for the note budget keeps a truthful, deterministic cut.
    const attached = new Map<number, string>()
    let noteChars = 0
    for (const [index, note] of [...reduced.notes.entries()].sort((a, b) => a[0] - b[0])) {
      const trimmed = note.length > NOTES_ENTRY_CHARS ? note.slice(0, NOTES_ENTRY_CHARS) : note
      if (noteChars + trimmed.length > NOTES_TOTAL_CHARS) break

      attached.set(index, trimmed)
      noteChars += trimmed.length
    }

    context = applyEntryNotes(context, attached)
    const dropped = reduced.notes.size - attached.size
    console.log(
      `[local-ai] reduce: ${attached.size} of ${pending.length} entrie(s) summarised in ` +
        `${reduced.calls} call(s) (${reduced.cached} cached${
          reduced.failed > 0 ? `, ${reduced.failed} failed` : ""
        }${dropped > 0 ? `, ${dropped} over the note budget` : ""}) → ${noteChars} note chars in ${
          Date.now() - startedAt
        }ms`,
    )
  }

  const localContext = formatLocalContext(context)
  if (localContext === "") {
    console.warn(
      "[local-ai] chat: no localAIContext arrived, so the model cannot see the Folo entries " +
        "(the client attaches them only when local AI is enabled and the chat has context blocks)",
    )
  }

  const result = streamText({
    model,
    system: buildChatSystemPrompt(DEFAULT_CHAT_SYSTEM_PROMPT, localContext, language),
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
