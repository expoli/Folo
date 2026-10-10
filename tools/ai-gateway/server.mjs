#!/usr/bin/env node
/**
 * Folo local AI gateway.
 *
 * Implements the subset of Folo's `/ai/*` API that the (patched) desktop and mobile clients
 * call, but runs the actual inference against an OpenAI-compatible endpoint of your choice
 * (vLLM / LM Studio / Ollama / LiteLLM / internal gateway / OpenAI itself).
 *
 * Implemented endpoints:
 *   POST /ai/chat                 AI SDK UI message stream (chat)
 *   GET  /ai/chat/:id/stream      stream resumption — always 204, no server-side history
 *   GET  /ai/chat/config          model list + empty quota + chat context budget
 *   POST /ai/summary              entry summary (entry text travels in the request; long
 *                                 content is summarized in chunks and merged)
 *   POST /ai/translation/batch    NDJSON stream of `{ id, data }`; long fields are translated
 *                                 chunk by chunk and rejoined per field
 *   GET  /health                  liveness probe (`?probe=1` also calls the model once)
 *
 * Not implemented (still served by Folo's own API, because they need its closed-source
 * backend): text-to-speech, AI tasks / daily digests, MCP services, AI chat memory,
 * server-side chat history sync.
 */
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"

import { createOpenAI } from "@ai-sdk/openai"
import { generateText, streamText } from "ai"

// Load `tools/ai-gateway/.env` when it exists, so the gateway starts with the same configuration
// however it is launched (no shell-specific `source`, which breaks in fish). Real environment
// variables still take precedence over the file.
try {
  process.loadEnvFile(fileURLToPath(new URL("./.env", import.meta.url)))
} catch {
  // No .env file: fall back to the environment and the built-in defaults.
}

const DEFAULT_CHAT_SYSTEM_PROMPT = [
  "You are Folo's reading assistant. You help the user understand the articles, feeds and",
  "newsletters they follow. Answer in the language the user writes in, be concise, and base",
  "your answer on the provided context when there is any. If the context does not contain the",
  "answer, say so instead of inventing details.",
].join(" ")

const DEFAULT_SUMMARY_SYSTEM_PROMPT = [
  "You summarize articles for a reader who wants the gist quickly.",
  "Reply with the summary only — no preamble, no meta commentary — using Markdown",
  "(a short paragraph, or 3-5 bullets if the article lists several distinct points).",
].join(" ")

const DEFAULT_TRANSLATION_SYSTEM_PROMPT = [
  "You are a professional translator. Translate faithfully, keep the original formatting,",
  "markdown and inline code, and never add explanations or notes.",
].join(" ")

// The local gateway has no access to Folo's backend, so a request without attached context really
// has no entries. Say that instead of inventing a timeline or feed list.
const NO_CONTEXT_NOTE = [
  "This request carries no Folo entries, feed list or timeline: a self-hosted gateway cannot read",
  "the user's Folo data. If the user asks about their timeline, feeds or articles, say you cannot",
  "see them and that the content has to be attached to the conversation (Folo's context bar /",
  "timeline summary), then answer from what they paste instead of inventing entries.",
].join(" ")

const config = {
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 8788),
  token: process.env.GATEWAY_TOKEN || "",
  upstream: {
    baseUrl: process.env.AI_BASE_URL || "https://api.openai.com/v1",
    apiKey: process.env.AI_API_KEY || "not-needed",
    headers: parseHeaders(process.env.AI_HEADERS),
  },
  models: [],
  defaultModel: process.env.AI_MODEL || "",
  temperature: process.env.AI_TEMPERATURE ? Number(process.env.AI_TEMPERATURE) : undefined,
  maxOutputTokens: process.env.AI_MAX_OUTPUT_TOKENS
    ? Number(process.env.AI_MAX_OUTPUT_TOKENS)
    : 2048,
  translationConcurrency: Number(process.env.AI_TRANSLATION_CONCURRENCY || 3),
  // Content longer than these limits is summarized / translated in several calls instead of
  // being cut to fit one request (see `splitIntoChunks`).
  summaryChunkChars: positiveInt(process.env.AI_SUMMARY_CHUNK_CHARS, 12000),
  translationChunkChars: positiveInt(process.env.AI_TRANSLATION_CHUNK_CHARS, 8000),
  // How much article text the client may attach to a chat request; announced via
  // `GET /ai/chat/config` and consumed by `buildLocalAIContext`.
  context: {
    maxEntries: positiveInt(process.env.AI_CONTEXT_MAX_ENTRIES, 20),
    maxCharsPerEntry: positiveInt(process.env.AI_CONTEXT_MAX_CHARS_PER_ENTRY, 20000),
    maxTotalChars: positiveInt(process.env.AI_CONTEXT_MAX_TOTAL_CHARS, 60000),
  },
  chatSystemPrompt: process.env.AI_CHAT_SYSTEM_PROMPT || DEFAULT_CHAT_SYSTEM_PROMPT,
  summarySystemPrompt: process.env.AI_SUMMARY_SYSTEM_PROMPT || DEFAULT_SUMMARY_SYSTEM_PROMPT,
  translationSystemPrompt:
    process.env.AI_TRANSLATION_SYSTEM_PROMPT || DEFAULT_TRANSLATION_SYSTEM_PROMPT,
  maxBodyBytes: 32 * 1024 * 1024,
}

config.models = (process.env.AI_MODELS || "")
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean)
config.defaultModel = config.defaultModel || config.models[0] || "gpt-4o-mini"
if (config.models.length === 0) {
  config.models = [config.defaultModel]
}

const openai = createOpenAI({
  baseURL: config.upstream.baseUrl,
  apiKey: config.upstream.apiKey,
  headers: config.upstream.headers,
})

/** OpenAI-compatible endpoints talk plain chat completions; `openai()` would use `/responses`. */
const resolveModel = (modelId) => openai.chat(modelId)

const modelFor = (requested) => {
  if (requested && config.models.includes(requested)) return requested
  if (requested && requested !== config.defaultModel) {
    console.warn(`[gateway] unknown model "${requested}", falling back to ${config.defaultModel}`)
  }
  return config.defaultModel
}

function parseHeaders(raw) {
  if (!raw) return undefined

  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === "object" && parsed !== null ? parsed : undefined
  } catch {
    console.warn("[gateway] AI_HEADERS is not valid JSON, ignoring it")
    return undefined
  }
}

function positiveInt(raw, fallback) {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

const LANGUAGE_NAMES = {
  en: "English",
  ja: "Japanese",
  "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese",
  "fr-FR": "French",
}

const languageName = (language) => LANGUAGE_NAMES[language] || language || "English"

/* ------------------------------------------------------------------ helpers */

const sendJson = (res, status, payload) => {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  })
  res.end(body)
}

const readJsonBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks = []

    req.on("data", (chunk) => {
      size += chunk.length
      if (size > config.maxBodyBytes) {
        reject(new Error("Request body too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      if (!raw.trim()) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`))
      }
    })
    req.on("error", reject)
  })

const setCorsHeaders = (res) => {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "*")
  res.setHeader("Access-Control-Max-Age", "86400")
}

const isAuthorized = (req) => {
  if (!config.token) return true

  const header = req.headers.authorization || ""
  return header === `Bearer ${config.token}`
}

/** Flattens AI SDK UI messages, including Folo's `data-rich-text` / `data-*` parts, into text. */
const messageText = (message) => {
  const parts = Array.isArray(message?.parts) ? message.parts : []

  return parts
    .map((part) => {
      if (!part || typeof part !== "object") return ""
      if (part.type === "text" && typeof part.text === "string") return part.text
      if (typeof part.type === "string" && part.type.startsWith("data-")) {
        const data = part.data
        if (data && typeof data === "object" && typeof data.text === "string") return data.text
      }
      return ""
    })
    .filter(Boolean)
    .join("\n\n")
    .trim()
}

const toModelMessages = (messages = []) =>
  messages
    .map((message) => {
      const text = messageText(message)
      if (!text) return null

      const role =
        message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user"

      return { role, content: text }
    })
    .filter(Boolean)

/** Renders the entries the client resolved from the chat context bar. */
const formatLocalContext = (context) => {
  const contextEntries = Array.isArray(context?.entries) ? context.entries : []
  const feeds = Array.isArray(context?.feeds) ? context.feeds : []
  if (contextEntries.length === 0 && feeds.length === 0) return ""

  const blocks = Array.isArray(context.blocks)
    ? context.blocks
        .map((block) => `${block.type}="${block.value}"`)
        .filter(Boolean)
        .join(", ")
    : ""

  const entries = contextEntries
    .map((entry, index) => {
      const header = [entry.title || "(untitled)", entry.url, entry.publishedAt]
        .filter(Boolean)
        .join(" — ")
      return `### [${index + 1}] ${header}\n${entry.content || "(no content available)"}`
    })
    .join("\n\n")

  const feedSection = feeds
    .map((feed, index) => {
      const header = [feed.title || "(untitled)", feed.url].filter(Boolean).join(" — ")
      return `### [F${index + 1}] ${header}\n${feed.description || "(no description)"}`
    })
    .join("\n\n")

  return [
    contextEntries.length > 0
      ? "The user is currently looking at the following entries in Folo."
      : "",
    feeds.length > 0
      ? "Candidate feeds the user could subscribe to (pick only from this list):"
      : "",
    blocks ? `Context selection: ${blocks}` : "",
    entries,
    feedSection,
  ]
    .filter((line) => line !== "")
    .join("\n")
}

/** Strips a ```json … ``` fence without a backtracking-prone regex. */
const stripCodeFence = (text) => {
  const trimmed = text.trim()
  if (!trimmed.startsWith("```")) return trimmed

  const firstNewline = trimmed.indexOf("\n")
  const body = firstNewline === -1 ? trimmed.slice(3) : trimmed.slice(firstNewline + 1)
  const closing = body.lastIndexOf("```")

  return (closing === -1 ? body : body.slice(0, closing)).trim()
}

const parseJsonLoose = (text) => {
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

/* ------------------------------------------------------------------ routes */

const handleChat = async (req, res, body) => {
  const messages = toModelMessages(body.messages)
  if (messages.length === 0) {
    sendJson(res, 400, { error: "No message text found in the request" })
    return
  }

  const localContext = formatLocalContext(body.localAIContext)
  const contextBlocks = Array.isArray(body.localAIContext?.blocks)
    ? body.localAIContext.blocks.length
    : 0
  const contextEntries = Array.isArray(body.localAIContext?.entries)
    ? body.localAIContext.entries.length
    : 0
  const contextFeeds = Array.isArray(body.localAIContext?.feeds)
    ? body.localAIContext.feeds.length
    : 0
  let contextChars = 0
  for (const entry of body.localAIContext?.entries ?? []) {
    if (typeof entry?.content === "string") contextChars += entry.content.length
  }

  console.log(
    `[gateway] chat: model=${modelFor(body.model)} messages=${messages.length} ` +
      `context=${contextBlocks} block(s)/${contextEntries} entrie(s)/${contextFeeds} feed(s)/${contextChars} chars`,
  )
  if (localContext === "") {
    console.warn(
      "[gateway] chat: no localAIContext arrived, so the model cannot see the Folo entries " +
        "(the client attaches them only when the gateway is enabled and the chat has context blocks)",
    )
  }

  const systemPrompt = [
    config.chatSystemPrompt,
    localContext,
    localContext === "" ? NO_CONTEXT_NOTE : "",
  ]
    .filter(Boolean)
    .join("\n\n")

  const result = streamText({
    model: resolveModel(modelFor(body.model)),
    system: systemPrompt,
    messages,
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
  })

  const response = result.toUIMessageStreamResponse({
    sendReasoning: true,
    onError: (error) => {
      console.error("[gateway] chat stream error:", error)
      return error?.message || "Local AI gateway error"
    },
  })

  setCorsHeaders(res)
  const headers = Object.fromEntries(response.headers.entries())
  // Let Node chunk the SSE body instead of trusting a length the upstream may have set.
  delete headers["content-length"]
  res.writeHead(response.status, headers)
  if (!response.body) {
    res.end()
    return
  }

  for await (const chunk of response.body) {
    res.write(chunk)
  }
  res.end()
}

/** Splits long text at paragraph boundaries, falling back to hard cuts for huge paragraphs. */
const splitIntoChunks = (text, maxChars) => {
  const chunks = []
  let current = ""

  const flush = () => {
    if (current.trim()) chunks.push(current.trim())
    current = ""
  }

  for (const block of text.split(/\n{2,}/)) {
    if (block.length > maxChars) {
      flush()
      for (let index = 0; index < block.length; index += maxChars) {
        chunks.push(block.slice(index, index + maxChars))
      }
      continue
    }

    if (current && current.length + block.length + 2 > maxChars) flush()
    current = current ? `${current}\n\n${block}` : block
  }
  flush()

  return chunks.length > 0 ? chunks : [text]
}

const summarizeChunk = async (model, { language, title, content, part }) => {
  const { text } = await generateText({
    model,
    system: config.summarySystemPrompt,
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
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
  })

  return typeof text === "string" ? text.trim() : ""
}

const mergeSummaryChunks = async (model, language, partials) => {
  const { text } = await generateText({
    model,
    system: config.summarySystemPrompt,
    prompt: [
      `Merge these ${partials.length} partial summaries of one article into a single summary in ${languageName(language)}.`,
      "Keep every distinct point, remove repetitions, and do not mention the parts or this merging step.",
      "",
      partials.map((partial, index) => `## Part ${index + 1}\n${partial}`).join("\n\n"),
    ].join("\n"),
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
  })

  return typeof text === "string" ? text.trim() : ""
}

const summarizeContent = async ({ model, language, title, content }) => {
  const chunks = splitIntoChunks(content, config.summaryChunkChars)

  if (chunks.length === 1) {
    const summary = await summarizeChunk(model, { language, title, content: chunks[0] })
    return summary || null
  }

  const partials = []
  for (const [index, chunk] of chunks.entries()) {
    const summary = await summarizeChunk(model, {
      language,
      title,
      content: chunk,
      part: { index: index + 1, total: chunks.length },
    })
    if (summary) partials.push(summary)
  }

  if (partials.length === 0) return null

  const merged = await mergeSummaryChunks(model, language, partials)
  // Report the parts that survived, so a failed chunk cannot read as full coverage.
  const coverage = `_Summarized the full article in ${partials.length} of ${chunks.length} parts (${content.length} characters)._`

  // The coverage note stays explicit so a merged summary is never mistaken for a partial one.
  return merged ? `${merged}\n\n${coverage}` : coverage
}

const handleSummary = async (req, res, body) => {
  const content = typeof body.content === "string" ? body.content.trim() : ""
  if (!content) {
    sendJson(res, 400, { error: "Field `content` is required" })
    return
  }

  const data = await summarizeContent({
    model: resolveModel(modelFor(body.model)),
    language: body.language,
    title: body.title,
    content,
  })

  sendJson(res, 200, { code: 0, data })
}

/** One JSON request covering the short fields of an entry, as before chunking existed. */
const translateShortFields = async (model, entry, fields, language) => {
  const parts = []
  for (const field of fields) {
    const value = entry[field]
    if (typeof value === "string" && value.trim()) {
      parts.push(`## ${field}\n${value}`)
    }
  }

  if (parts.length === 0) return null

  const { text } = await generateText({
    model,
    system: config.translationSystemPrompt,
    prompt: [
      `Translate each section below into ${languageName(language)}.`,
      `Reply with a JSON object using exactly these keys: ${fields.join(", ")}.`,
      "Values must be the translated text only (keep Markdown, no notes).",
      "",
      parts.join("\n\n"),
    ].join("\n"),
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
  })

  const parsed = parseJsonLoose(text)
  if (!parsed || typeof parsed !== "object") {
    // Fall back to the raw answer so that a chatty model still produces a usable translation.
    return fields.length === 1 ? { [fields[0]]: text.trim() } : null
  }

  const data = {}
  for (const field of fields) {
    const value = parsed[field]
    if (typeof value === "string") {
      data[field] = value.trim()
    }
  }

  return Object.keys(data).length > 0 ? data : null
}

/** A field too long for one request is translated paragraph by paragraph and rejoined. */
const translateLongField = async (model, field, value, language) => {
  const chunks = splitIntoChunks(value, config.translationChunkChars)
  const translated = []

  for (const [index, chunk] of chunks.entries()) {
    const { text } = await generateText({
      model,
      system: config.translationSystemPrompt,
      prompt: [
        `Translate the text below into ${languageName(language)}.`,
        `It is part ${index + 1} of ${chunks.length} of the "${field}" field of one article.`,
        "Reply with the translated text only (keep Markdown, no notes).",
        "",
        chunk,
      ].join("\n"),
      temperature: config.temperature,
      maxOutputTokens: config.maxOutputTokens,
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

const translateEntry = async (entry, fields, language) => {
  const model = resolveModel(modelFor(entry.model))
  const shortFields = []
  const longFields = []

  for (const field of fields) {
    const value = entry[field]
    if (typeof value !== "string" || !value.trim()) continue

    if (value.length > config.translationChunkChars) {
      longFields.push(field)
    } else {
      shortFields.push(field)
    }
  }

  const data = {}

  if (shortFields.length > 0) {
    Object.assign(data, (await translateShortFields(model, entry, shortFields, language)) ?? {})
  }

  for (const field of longFields) {
    const translated = await translateLongField(model, field, entry[field], language)
    if (translated) data[field] = translated
  }

  return Object.keys(data).length > 0 ? data : null
}

const handleTranslationBatch = async (req, res, body) => {
  const entries = Array.isArray(body.entries) ? body.entries : []
  const fields = (Array.isArray(body.fields) ? body.fields : []).filter((field) =>
    ["title", "description", "content", "readabilityContent"].includes(field),
  )

  if (entries.length === 0 || fields.length === 0) {
    sendJson(res, 400, { error: "Fields `entries` and `fields` are required" })
    return
  }

  setCorsHeaders(res)
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  })

  const queue = [...entries]
  const worker = async () => {
    for (;;) {
      const entry = queue.shift()
      if (!entry) return

      try {
        const data = await translateEntry({ ...entry, model: body.model }, fields, body.language)
        if (data) {
          res.write(`${JSON.stringify({ id: entry.id, data })}\n`)
        }
      } catch (error) {
        console.error(`[gateway] translation failed for ${entry?.id}:`, error)
      }
    }
  }

  try {
    await Promise.all(
      Array.from(
        { length: Math.max(1, Math.min(config.translationConcurrency, entries.length)) },
        () => worker(),
      ),
    )
  } finally {
    res.end()
  }
}

const handleConfig = (res) => {
  sendJson(res, 200, {
    defaultModel: config.defaultModel,
    availableModels: config.models,
    availableModelsMenu: config.models.map((model) => ({ label: model, value: model })),
    // How much article text the client may attach to a chat request; the client falls back to
    // its own conservative defaults when this field is missing (older gateway builds).
    localAIContext: config.context,
    // A self-hosted gateway has no Folo quota; report empty instead of inventing numbers.
    rateLimit: {
      maxTokens: 0,
      currentTokens: 0,
      remainingTokens: 0,
      windowDuration: 0,
      windowResetTime: 0,
    },
    attachmentLimits: {
      maxFiles: 0,
      remainingFiles: 0,
      windowDuration: 0,
      windowResetTime: 0,
    },
    usage: {
      total: 0,
      used: 0,
      remaining: 0,
      resetAt: new Date(0).toISOString(),
    },
    freeQuota: {
      shouldCheckDailyLimit: false,
      remainingRequests: 0,
      remainingMonthlyRequests: 0,
      role: "free",
      dailyLimit: 0,
      monthlyLimit: 0,
    },
  })
}

const probeUpstream = async () => {
  const startedAt = Date.now()

  try {
    await generateText({
      model: resolveModel(config.defaultModel),
      prompt: "ping",
      maxOutputTokens: 1,
    })

    return { ok: true, latencyMs: Date.now() - startedAt }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error?.message || "probe failed",
    }
  }
}

const server = createServer(async (req, res) => {
  setCorsHeaders(res)

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
  const { pathname } = url

  if (req.method === "OPTIONS") {
    res.writeHead(204)
    res.end()
    return
  }

  try {
    if (pathname === "/health") {
      const payload = {
        ok: true,
        upstream: config.upstream.baseUrl,
        defaultModel: config.defaultModel,
        models: config.models,
      }

      // `?probe=1` spends one minimal model call so a client can tell "gateway is up" from
      // "model/upstream is reachable". Without it the handler stays instant, as before.
      const probe = url.searchParams.get("probe")
      if (probe === "1" || probe === "true") {
        payload.probe = await probeUpstream()
      }

      sendJson(res, 200, payload)
      return
    }

    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: "Unauthorized" })
      return
    }

    if (req.method === "GET" && pathname === "/ai/chat/config") {
      handleConfig(res)
      return
    }

    // Stream resumption: the client polls this when opening an existing chat. There is no
    // server-side history here, so always answer "no active stream".
    if (req.method === "GET" && /^\/ai\/chat\/[^/]+\/stream$/.test(pathname)) {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method === "POST" && pathname === "/ai/chat") {
      await handleChat(req, res, await readJsonBody(req))
      return
    }

    if (req.method === "POST" && pathname === "/ai/summary") {
      await handleSummary(req, res, await readJsonBody(req))
      return
    }

    if (req.method === "POST" && pathname === "/ai/translation/batch") {
      await handleTranslationBatch(req, res, await readJsonBody(req))
      return
    }

    sendJson(res, 404, { error: `Unsupported endpoint: ${req.method} ${pathname}` })
  } catch (error) {
    console.error("[gateway] request failed:", error)
    if (!res.headersSent) {
      sendJson(res, 500, { error: error?.message || "Internal error" })
    } else {
      res.end()
    }
  }
})

server.listen(config.port, config.host, () => {
  console.log(`[gateway] listening on http://${config.host}:${config.port}`)
  console.log(`[gateway] upstream   ${config.upstream.baseUrl}`)
  console.log(`[gateway] models     ${config.models.join(", ")} (default: ${config.defaultModel})`)
  if (!config.token) {
    console.warn("[gateway] GATEWAY_TOKEN is not set — anyone who can reach this port can use it")
  }
})
