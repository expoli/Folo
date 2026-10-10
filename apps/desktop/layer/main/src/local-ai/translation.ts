import type { LanguageModel } from "ai"
import { generateText } from "ai"

import { splitIntoChunks } from "./chunking"
import { jsonResponse } from "./http"
import { DEFAULT_TRANSLATION_SYSTEM_PROMPT, languageName } from "./prompts"
import type { DirectCallOptions } from "./provider"
import { MAX_OUTPUT_TOKENS } from "./provider"

/** A field longer than this is translated chunk by chunk, like `AI_TRANSLATION_CHUNK_CHARS`. */
export const TRANSLATION_CHUNK_CHARS = 8000

/** Entries translated at the same time, matching `AI_TRANSLATION_CONCURRENCY`' default. */
export const TRANSLATION_CONCURRENCY = 3

export type TranslatedEntryData = Record<string, string>

/** Strips a ```json … ``` fence without a backtracking-prone regex. */
const stripCodeFence = (text: string) => {
  const trimmed = text.trim()
  if (!trimmed.startsWith("```")) return trimmed

  const firstNewline = trimmed.indexOf("\n")
  const body = firstNewline === -1 ? trimmed.slice(3) : trimmed.slice(firstNewline + 1)
  const closing = body.lastIndexOf("```")

  return (closing === -1 ? body : body.slice(0, closing)).trim()
}

const parseJsonLoose = (text?: string | null): unknown => {
  if (!text) return null

  const candidate = stripCodeFence(text)

  try {
    return JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf("{")
    const end = candidate.lastIndexOf("}")
    if (start === -1 || end <= start) return null

    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch {
      return null
    }
  }
}

/** One JSON request covering the short fields of an entry, as before chunking existed. */
export const translateShortFields = async (
  model: LanguageModel,
  entry: Record<string, unknown>,
  fields: string[],
  language?: string | null,
  call?: DirectCallOptions,
): Promise<TranslatedEntryData | null> => {
  const parts: string[] = []
  for (const field of fields) {
    const value = entry[field]
    if (typeof value === "string" && value.trim()) {
      parts.push(`## ${field}\n${value}`)
    }
  }

  if (parts.length === 0) return null

  const { text } = await generateText({
    model,
    system: DEFAULT_TRANSLATION_SYSTEM_PROMPT,
    prompt: [
      `Translate each section below into ${languageName(language)}.`,
      `Reply with a JSON object using exactly these keys: ${fields.join(", ")}.`,
      "Values must be the translated text only (keep Markdown, no notes).",
      "",
      parts.join("\n\n"),
    ].join("\n"),
    maxOutputTokens: call?.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
    temperature: call?.temperature,
    providerOptions: call?.providerOptions,
  })

  const parsed = parseJsonLoose(text)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    // Fall back to the raw answer so that a chatty model still produces a usable translation.
    return fields.length === 1 ? { [fields[0]!]: (text ?? "").trim() } : null
  }

  const data: TranslatedEntryData = {}
  for (const field of fields) {
    const value = (parsed as Record<string, unknown>)[field]
    if (typeof value === "string") {
      data[field] = value.trim()
    }
  }

  return Object.keys(data).length > 0 ? data : null
}

/** A field too long for one request is translated paragraph by paragraph and rejoined. */
export const translateLongField = async (
  model: LanguageModel,
  field: string,
  value: string,
  language?: string | null,
  call?: DirectCallOptions,
): Promise<string | null> => {
  const chunks = splitIntoChunks(value, call?.translationChunkChars ?? TRANSLATION_CHUNK_CHARS)
  const translated: string[] = []

  for (const [index, chunk] of chunks.entries()) {
    const { text } = await generateText({
      model,
      system: DEFAULT_TRANSLATION_SYSTEM_PROMPT,
      prompt: [
        `Translate the text below into ${languageName(language)}.`,
        `It is part ${index + 1} of ${chunks.length} of the "${field}" field of one article.`,
        "Reply with the translated text only (keep Markdown, no notes).",
        "",
        chunk,
      ].join("\n"),
      maxOutputTokens: call?.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
      temperature: call?.temperature,
      providerOptions: call?.providerOptions,
    })

    if (typeof text === "string" && text.trim()) {
      translated.push(text.trim())
    } else {
      // Keep the part visible instead of silently shipping a translation with a hole in it.
      translated.push(`[…part ${index + 1} of ${chunks.length} left untranslated]`)
    }
  }

  return translated.length > 0 ? translated.join("\n\n") : null
}

export const translateEntry = async (
  model: LanguageModel,
  entry: Record<string, unknown>,
  fields: string[],
  language?: string | null,
  call?: DirectCallOptions,
): Promise<TranslatedEntryData | null> => {
  const shortFields: string[] = []
  const longFields: string[] = []

  for (const field of fields) {
    const value = entry[field]
    if (typeof value !== "string" || !value.trim()) continue

    if (value.length > (call?.translationChunkChars ?? TRANSLATION_CHUNK_CHARS)) {
      longFields.push(field)
    } else {
      shortFields.push(field)
    }
  }

  const data: TranslatedEntryData = {}

  if (shortFields.length > 0) {
    Object.assign(
      data,
      (await translateShortFields(model, entry, shortFields, language, call)) ?? {},
    )
  }

  for (const field of longFields) {
    const translated = await translateLongField(
      model,
      field,
      entry[field] as string,
      language,
      call,
    )
    if (translated) data[field] = translated
  }

  return Object.keys(data).length > 0 ? data : null
}

const TRANSLATABLE_FIELDS = ["title", "description", "content", "readabilityContent"]

/**
 * Answers `POST /ai/translation/batch`. The reply is an NDJSON body of `{ id, data }` lines, the
 * same contract `readNdjsonStream` consumes from Folo's own API and from a self-hosted gateway.
 */
export const handleTranslationBatchRequest = async (params: {
  body: Record<string, unknown>
  model: LanguageModel
  call?: DirectCallOptions
}): Promise<Response> => {
  const { body, model, call } = params
  const entries = Array.isArray(body.entries)
    ? (body.entries as Record<string, unknown>[]).filter(
        (entry) => entry && typeof entry === "object",
      )
    : []
  const fields = (Array.isArray(body.fields) ? (body.fields as string[]) : []).filter((field) =>
    TRANSLATABLE_FIELDS.includes(field),
  )
  const language = typeof body.language === "string" ? body.language : null

  if (entries.length === 0 || fields.length === 0) {
    return jsonResponse(400, { error: "Fields `entries` and `fields` are required" })
  }

  const lines: string[] = []
  const queue = [...entries]
  const worker = async () => {
    for (;;) {
      const entry = queue.shift()
      if (!entry) return

      try {
        const data = await translateEntry(model, entry, fields, language, call)
        if (data) {
          lines.push(`${JSON.stringify({ id: String(entry.id), data })}\n`)
        }
      } catch (error) {
        console.error(`[local-ai] translation failed for ${String(entry.id)}:`, error)
      }
    }
  }

  await Promise.all(
    Array.from(
      {
        length: Math.max(
          1,
          Math.min(call?.translationConcurrency ?? TRANSLATION_CONCURRENCY, entries.length),
        ),
      },
      () => worker(),
    ),
  )

  return new Response(lines.join(""), {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  })
}
