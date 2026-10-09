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
 *   GET  /ai/chat/config          model list + empty quota, feeds the model picker
 *   POST /ai/summary              entry summary (entry text travels in the request)
 *   POST /ai/translation/batch    NDJSON stream of `{ id, data }`
 *   GET  /health                  liveness probe
 *
 * Not implemented (still served by Folo's own API, because they need its closed-source
 * backend): text-to-speech, AI tasks / daily digests, MCP services, AI chat memory,
 * server-side chat history sync.
 */
import { createServer } from "node:http"

import { createOpenAI } from "@ai-sdk/openai"
import { generateText, streamText } from "ai"

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
  if (!context || !Array.isArray(context.entries) || context.entries.length === 0) return ""

  const blocks = Array.isArray(context.blocks)
    ? context.blocks
        .map((block) => `${block.type}="${block.value}"`)
        .filter(Boolean)
        .join(", ")
    : ""

  const entries = context.entries
    .map((entry, index) => {
      const header = [entry.title || "(untitled)", entry.url, entry.publishedAt]
        .filter(Boolean)
        .join(" — ")
      return `### [${index + 1}] ${header}\n${entry.content || "(no content available)"}`
    })
    .join("\n\n")

  return [
    "The user is currently looking at the following entries in Folo.",
    blocks ? `Context selection: ${blocks}` : "",
    "",
    entries,
  ]
    .filter((line) => line !== undefined)
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
  const systemPrompt = [config.chatSystemPrompt, localContext].filter(Boolean).join("\n\n")

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

const handleSummary = async (req, res, body) => {
  const content = typeof body.content === "string" ? body.content.trim() : ""
  if (!content) {
    sendJson(res, 400, { error: "Field `content` is required" })
    return
  }

  const { text } = await generateText({
    model: resolveModel(modelFor(body.model)),
    system: config.summarySystemPrompt,
    prompt: [
      `Write the summary in ${languageName(body.language)}.`,
      body.title ? `Title: ${body.title}` : "",
      "",
      content,
    ]
      .filter(Boolean)
      .join("\n"),
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
  })

  const data = typeof text === "string" && text.trim() ? text.trim() : null
  sendJson(res, 200, { code: 0, data })
}

const translateEntry = async (entry, fields, language) => {
  const parts = []
  for (const field of fields) {
    const value = entry[field]
    if (typeof value === "string" && value.trim()) {
      parts.push(`## ${field}\n${value}`)
    }
  }

  if (parts.length === 0) return null

  const { text } = await generateText({
    model: resolveModel(modelFor(entry.model)),
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
      sendJson(res, 200, {
        ok: true,
        upstream: config.upstream.baseUrl,
        defaultModel: config.defaultModel,
        models: config.models,
      })
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
