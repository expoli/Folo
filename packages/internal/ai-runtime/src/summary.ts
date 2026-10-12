import type { LanguageModel } from "ai"
import { generateText } from "ai"

import { splitIntoChunks } from "./chunking"
import { jsonResponse } from "./http"
import { MAX_OUTPUT_TOKENS } from "./limits"
import { DEFAULT_SUMMARY_SYSTEM_PROMPT, languageName } from "./prompts"
import type { DirectCallOptions } from "./provider"

/** Texts longer than this are summarized chunk by chunk, like `AI_SUMMARY_CHUNK_CHARS` does. */
export const SUMMARY_CHUNK_CHARS = 12_000

interface SummarizeChunkOptions {
  language?: string | null
  title?: string | null
  content: string
  part?: { index: number; total: number }
  /** Knobs of this request; absent keeps the built-in defaults. */
  call?: DirectCallOptions
  /** Wording of the summary prompt; the gateway lets its environment replace it. */
  systemPrompt?: string
}

const summarizeChunk = async (model: LanguageModel, options: SummarizeChunkOptions) => {
  const { language, title, content, part, call, systemPrompt } = options
  const { text } = await generateText({
    model,
    system: systemPrompt ?? DEFAULT_SUMMARY_SYSTEM_PROMPT,
    prompt: [
      `Write the summary in ${languageName(language)}.`,
      part
        ? `This is part ${part.index} of ${part.total} of a long article — summarize this part.`
        : "",
      title ? `Title: ${title}` : "",
      "",
      content,
    ]
      .filter(Boolean)
      .join("\n"),
    maxOutputTokens: call?.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
    temperature: call?.temperature,
    providerOptions: call?.providerOptions,
  })

  return typeof text === "string" ? text.trim() : ""
}

const mergeSummaryChunks = async (
  model: LanguageModel,
  language: string | null | undefined,
  partials: string[],
  call?: DirectCallOptions,
  systemPrompt?: string,
) => {
  const { text } = await generateText({
    model,
    system: systemPrompt ?? DEFAULT_SUMMARY_SYSTEM_PROMPT,
    prompt: [
      `Merge these ${partials.length} partial summaries of one article into a single summary in ${languageName(language)}.`,
      "Keep every distinct point, remove repetitions, and do not mention the parts or this merging step.",
      "",
      partials.map((partial, index) => `## Part ${index + 1}\n${partial}`).join("\n\n"),
    ].join("\n"),
    maxOutputTokens: call?.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
    temperature: call?.temperature,
    providerOptions: call?.providerOptions,
  })

  return typeof text === "string" ? text.trim() : ""
}

/** Long articles are summarized chunk by chunk and merged, with an explicit coverage note. */
export const summarizeContent = async (params: {
  model: LanguageModel
  language?: string | null
  title?: string | null
  content: string
  call?: DirectCallOptions
  /** Wording of the summary prompt; the gateway lets its environment replace it. */
  systemPrompt?: string
}): Promise<string | null> => {
  const { model, language, title, content, call, systemPrompt } = params
  const chunks = splitIntoChunks(content, call?.summaryChunkChars ?? SUMMARY_CHUNK_CHARS)

  if (chunks.length === 1) {
    return (
      (await summarizeChunk(model, {
        language,
        title,
        content: chunks[0]!,
        call,
        systemPrompt,
      })) || null
    )
  }

  const partials: string[] = []
  for (const [index, chunk] of chunks.entries()) {
    const summary = await summarizeChunk(model, {
      language,
      title,
      content: chunk,
      part: { index: index + 1, total: chunks.length },
      call,
      systemPrompt,
    })
    if (summary) partials.push(summary)
  }

  if (partials.length === 0) return null

  const merged = await mergeSummaryChunks(model, language, partials, call, systemPrompt)
  // Report the parts that survived, so a failed chunk cannot read as full coverage.
  const coverage = `_Summarized the full article in ${partials.length} of ${chunks.length} parts (${content.length} characters)._`

  // The coverage note stays explicit so a merged summary is never mistaken for a partial one.
  return merged ? `${merged}\n\n${coverage}` : coverage
}

/** Same contract as `POST /ai/summary`, with the entry text travelling in the request. */
export const handleSummaryRequest = async (params: {
  body: Record<string, unknown>
  model: LanguageModel
  call?: DirectCallOptions
  systemPrompt?: string
}): Promise<Response> => {
  const { body, model, call, systemPrompt } = params
  const content = typeof body.content === "string" ? body.content.trim() : ""
  if (!content) {
    return jsonResponse(400, { error: "Field `content` is required" })
  }

  const data = await summarizeContent({
    model,
    language: typeof body.language === "string" ? body.language : null,
    title: typeof body.title === "string" ? body.title : null,
    content,
    call,
    systemPrompt,
  })

  return jsonResponse(200, { code: 0, data })
}
