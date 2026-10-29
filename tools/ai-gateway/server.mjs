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
 *   POST /ai/summary-title        short chat title, written by the same local model
 *   POST /ai/translation/batch    NDJSON stream of `{ id, data }`; long fields are translated
 *                                 chunk by chunk and rejoined per field
 *   GET  /health                  liveness probe (`?probe=1` also calls the model once)
 *
 * Not implemented (still served by Folo's own API, because they need its closed-source
 * backend): text-to-speech, AI tasks / daily digests, MCP services, AI chat memory,
 * server-side chat history sync.
 *
 * This file is the adapter only: environment parsing, authentication, CORS, body limits, the Node
 * request/response streaming, the notes file and the `@ai-sdk/openai` model resolution. The
 * prompts, the summary / title / translation work, the chat context and the reduce pre-pass come
 * from `@follow/ai-runtime`, the same package the desktop and mobile apps run in `direct` mode.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { createOpenAI } from "@ai-sdk/openai"
import { reduceChatContext } from "@follow/ai-runtime/chat"
import {
  buildChatSystemPrompt,
  describeChatContext,
  formatLocalContext,
  toModelMessages,
} from "@follow/ai-runtime/context"
import { errorMessage, statusForError } from "@follow/ai-runtime/errors"
import {
  MAX_CHUNK_CHARS,
  MAX_CONCURRENCY,
  MAX_OUTPUT_TOKENS,
  MAX_OUTPUT_TOKENS_LIMIT,
  MIN_CHUNK_CHARS,
} from "@follow/ai-runtime/limits"
import {
  DEFAULT_CHAT_SYSTEM_PROMPT,
  DEFAULT_REDUCE_SYSTEM_PROMPT,
  DEFAULT_SUMMARY_SYSTEM_PROMPT,
  DEFAULT_TITLE_SYSTEM_PROMPT,
  DEFAULT_TRANSLATION_SYSTEM_PROMPT,
} from "@follow/ai-runtime/prompts"
import { handleSummaryRequest } from "@follow/ai-runtime/summary"
import { handleSummaryTitleRequest } from "@follow/ai-runtime/title"
import { runTranslationBatch, TRANSLATABLE_FIELDS } from "@follow/ai-runtime/translation"
import { createUIMessageStream, createUIMessageStreamResponse, generateText, streamText } from "ai"

// Load `tools/ai-gateway/.env` when it exists, so the gateway starts with the same configuration
// however it is launched (no shell-specific `source`, which breaks in fish). Real environment
// variables still take precedence over the file.
try {
  process.loadEnvFile(fileURLToPath(new URL("./.env", import.meta.url)))
} catch {
  // No .env file: fall back to the environment and the built-in defaults.
}

/** A positive integer from the environment; anything unusable keeps the default. */
function positiveInt(raw, fallback) {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/** Same, but bounded: a typo must not turn into an unusable request. */
function boundedInt(raw, fallback, min, max) {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return fallback

  return Math.min(max, Math.max(min, Math.floor(value)))
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
  maxOutputTokens: boundedInt(
    process.env.AI_MAX_OUTPUT_TOKENS,
    MAX_OUTPUT_TOKENS,
    1,
    MAX_OUTPUT_TOKENS_LIMIT,
  ),
  translationConcurrency: boundedInt(process.env.AI_TRANSLATION_CONCURRENCY, 3, 1, MAX_CONCURRENCY),
  // Content longer than these limits is summarized / translated in several calls instead of
  // being cut to fit one request (see `splitIntoChunks` in `@follow/ai-runtime/chunking`).
  summaryChunkChars: boundedInt(
    process.env.AI_SUMMARY_CHUNK_CHARS,
    12000,
    MIN_CHUNK_CHARS,
    MAX_CHUNK_CHARS,
  ),
  translationChunkChars: boundedInt(
    process.env.AI_TRANSLATION_CHUNK_CHARS,
    8000,
    MIN_CHUNK_CHARS,
    MAX_CHUNK_CHARS,
  ),
  // How much article text the client may attach to a chat request; announced via
  // `GET /ai/chat/config` and consumed by `buildLocalAIContext`.
  context: {
    maxEntries: positiveInt(process.env.AI_CONTEXT_MAX_ENTRIES, 20),
    maxCharsPerEntry: positiveInt(process.env.AI_CONTEXT_MAX_CHARS_PER_ENTRY, 20000),
    maxTotalChars: positiveInt(process.env.AI_CONTEXT_MAX_TOTAL_CHARS, 60000),
  },
  // Articles a wide selection matches beyond the prompt budget are summarized first (see
  // `reduceChatContext` in `@follow/ai-runtime/chat`), so a summary of a whole day covers every
  // matched article instead of the newest twenty. The notes are attached in place of the texts.
  reduce: {
    maxEntries: positiveInt(process.env.AI_REDUCE_MAX_ENTRIES, 200),
    batchEntries: positiveInt(process.env.AI_REDUCE_BATCH_ENTRIES, 8),
    batchChars: positiveInt(process.env.AI_REDUCE_BATCH_CHARS, 16000),
    concurrency: boundedInt(
      process.env.AI_REDUCE_CONCURRENCY || process.env.AI_TRANSLATION_CONCURRENCY,
      3,
      1,
      MAX_CONCURRENCY,
    ),
    noteChars: positiveInt(process.env.AI_REDUCE_NOTE_CHARS, 600),
    notesTotalChars: positiveInt(process.env.AI_REDUCE_NOTES_TOTAL_CHARS, 30000),
    systemPrompt: process.env.AI_REDUCE_SYSTEM_PROMPT || DEFAULT_REDUCE_SYSTEM_PROMPT,
  },
  chatSystemPrompt: process.env.AI_CHAT_SYSTEM_PROMPT || DEFAULT_CHAT_SYSTEM_PROMPT,
  summarySystemPrompt: process.env.AI_SUMMARY_SYSTEM_PROMPT || DEFAULT_SUMMARY_SYSTEM_PROMPT,
  titleSystemPrompt: process.env.AI_TITLE_SYSTEM_PROMPT || DEFAULT_TITLE_SYSTEM_PROMPT,
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

/** The allowlist decides which model runs: an unknown request falls back to the default one. */
const modelFor = (requested) => {
  if (requested && config.models.includes(requested)) return requested
  if (requested && requested !== config.defaultModel) {
    console.warn(`[gateway] unknown model "${requested}", falling back to ${config.defaultModel}`)
  }
  return config.defaultModel
}

/**
 * Tuning of one model call, in the shape `@follow/ai-runtime` expects. The chat path deliberately
 * leaves the translation pool out, so the reduce concurrency below is the one that applies.
 */
const callOptions = {
  maxOutputTokens: config.maxOutputTokens,
  temperature: config.temperature,
  summaryChunkChars: config.summaryChunkChars,
  translationChunkChars: config.translationChunkChars,
}
const translationCallOptions = {
  ...callOptions,
  translationConcurrency: config.translationConcurrency,
}
const reduceOptions = {
  maxEntries: config.reduce.maxEntries,
  batchEntries: config.reduce.batchEntries,
  batchChars: config.reduce.batchChars,
  concurrency: config.reduce.concurrency,
  systemPrompt: config.reduce.systemPrompt,
}

/** Every line the runtime produces is prefixed with the process that owns the transport. */
const log = (line) => console.log(`[gateway] ${line}`)

/* ------------------------------------------------------------------ helpers */

const sendJson = (res, status, payload) => {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  })
  res.end(body)
}

/** Answers a `Response` produced by the runtime through the Node response. */
const sendRuntimeResponse = async (res, response) => {
  const body = await response.arrayBuffer()
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
  if (body.byteLength > 0) res.write(Buffer.from(body))
  res.end()
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

/* -------------------------------------------------------- notes (reduce cache) */

/**
 * Notes of earlier summaries, kept across restarts: the same day summarized again should not pay
 * for the same articles twice. `AI_REDUCE_CACHE=0` keeps them in memory only,
 * `AI_REDUCE_CACHE_FILE` moves the file. The runtime only asks for `get`/`set`; the file, the
 * debounce and the pruning are this process's own.
 */
const NOTES_CACHE_VERSION = 1
const NOTES_CACHE_LIMIT = 2000
const NOTES_CACHE_MAX_BYTES = 2 * 1024 * 1024
const notesCacheFile =
  process.env.AI_REDUCE_CACHE_FILE || join(homedir(), ".cache", "folo-ai-gateway", "notes.json")
const notesCacheEnabled = process.env.AI_REDUCE_CACHE !== "0"
const notesCache = new Map()
let notesCacheTimer = null
let notesCacheDirty = false

const readNotesCache = () => {
  if (!notesCacheEnabled) return

  try {
    const parsed = JSON.parse(readFileSync(notesCacheFile, "utf8"))
    if (parsed?.version !== NOTES_CACHE_VERSION || !parsed.notes) return

    for (const [key, value] of Object.entries(parsed.notes)) {
      if (typeof value?.note === "string" && value.note) {
        notesCache.set(key, { note: value.note, usedAt: Number(value.usedAt) || 0 })
      }
    }

    console.log(`[gateway] reduce: ${notesCache.size} cached note(s) from ${notesCacheFile}`)
  } catch {
    // No cache yet, or one that cannot be read: starting empty is cheaper than a failed request.
  }
}

const saveNotesCache = () => {
  if (!notesCacheEnabled || !notesCacheDirty) return

  notesCacheDirty = false
  try {
    const oldest = () => [...notesCache.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)[0]?.[0]
    while (notesCache.size > NOTES_CACHE_LIMIT) notesCache.delete(oldest())

    let bytes = JSON.stringify(Object.fromEntries(notesCache)).length
    while (bytes > NOTES_CACHE_MAX_BYTES && notesCache.size > 1) {
      notesCache.delete(oldest())
      bytes = JSON.stringify(Object.fromEntries(notesCache)).length
    }

    mkdirSync(dirname(notesCacheFile), { recursive: true })
    // A half-written file would lose every note, so the new content lands first and replaces the
    // old one in one step.
    const temporary = `${notesCacheFile}.tmp`
    writeFileSync(
      temporary,
      JSON.stringify({ version: NOTES_CACHE_VERSION, notes: Object.fromEntries(notesCache) }),
    )
    renameSync(temporary, notesCacheFile)
  } catch {
    // A cache that cannot be written still works for this run.
  }
}

const scheduleNotesSave = () => {
  notesCacheDirty = true
  if (!notesCacheEnabled || notesCacheTimer) return

  notesCacheTimer = setTimeout(() => {
    notesCacheTimer = null
    saveNotesCache()
  }, 1000)
  notesCacheTimer.unref?.()
}

/** The cache the runtime writes through; a note read is a note used, so hot notes outlive cold ones. */
const notesCacheForRuntime = {
  get(key) {
    const stored = notesCache.get(key)
    if (!stored) return undefined

    stored.usedAt = Date.now()
    scheduleNotesSave()
    return stored.note
  },
  set(key, note) {
    notesCache.set(key, { note, usedAt: Date.now() })
    scheduleNotesSave()
  },
}

readNotesCache()
process.on("exit", () => {
  if (notesCacheTimer) clearTimeout(notesCacheTimer)
  saveNotesCache()
})
// `exit` does not run for a signal, so a Ctrl+C must write the notes itself.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (notesCacheTimer) clearTimeout(notesCacheTimer)
    saveNotesCache()
    process.exit(0)
  })
}

/* ------------------------------------------------------------------ routes */

/** The one error shape both the model stream and the outer stream answer with. */
const streamError = (error) => {
  console.error("[gateway] chat stream error:", error)
  return error?.message || "Local AI gateway error"
}

const handleChat = async (req, res, body) => {
  const messages = await toModelMessages(body.messages)
  if (messages.length === 0) {
    sendJson(res, 400, { error: "No message text found in the request" })
    return
  }

  const stats = describeChatContext(body.localAIContext)
  // Resolved once: an unknown requested model falls back here, and the fallback is the model the
  // notes are cached under.
  const contextModelId = modelFor(body.model)
  console.log(
    `[gateway] chat: model=${contextModelId} messages=${messages.length} ` +
      `context=${stats.blocks} block(s)/${stats.entries} entrie(s)(${stats.withText} with text + ` +
      `${stats.reduceTexts} for reduce)/${stats.matched} matched/window=${
        stats.window || "none"
      }/${stats.feeds} feed(s)/${stats.contextChars} chars${stats.selection ? ` [${stats.selection}]` : ""}`,
  )

  const model = resolveModel(contextModelId)
  // A client that disconnects during the pre-pass should not keep the batches running.
  const controller = new AbortController()
  res.on("close", () => controller.abort())

  const language = typeof body.language === "string" && body.language ? body.language : null

  const stream = createUIMessageStream({
    onError: streamError,
    execute: async ({ writer }) => {
      // A selection too wide for the prompt arrives with the texts of the extra articles; the
      // shared pre-pass summarizes them first, so the answer covers the whole selection instead of
      // its first twenty articles. It takes a while on a busy day, so the client hears how far it
      // is while it runs.
      const reduced = await reduceChatContext({
        context: body.localAIContext ?? null,
        model,
        modelId: contextModelId,
        language,
        call: callOptions,
        notes: notesCacheForRuntime,
        options: reduceOptions,
        noteChars: config.reduce.noteChars,
        notesTotalChars: config.reduce.notesTotalChars,
        log,
        signal: controller.signal,
        onProgress: (done, total) => {
          // One id, so every update replaces the previous line instead of stacking a part per batch.
          writer.write({
            type: "data-reduce-progress",
            id: "reduce-progress",
            data: { done, total },
          })
        },
      })

      const localContext = formatLocalContext(reduced.context)
      if (localContext === "") {
        console.warn(
          "[gateway] chat: no localAIContext arrived, so the model cannot see the Folo entries " +
            "(the client attaches them only when the gateway is enabled and the chat has context blocks)",
        )
      }

      writer.merge(
        streamText({
          model,
          system: buildChatSystemPrompt(config.chatSystemPrompt, localContext, language),
          messages,
          temperature: callOptions.temperature,
          maxOutputTokens: callOptions.maxOutputTokens,
          abortSignal: controller.signal,
          // Reasoning models answer only after thinking; this line tells a spent budget apart from
          // an upstream that answers in `reasoning_content` alone.
          onFinish: ({ finishReason, usage }) => {
            console.log(
              `[gateway] chat done: finish=${finishReason ?? "?"} output=${
                usage?.outputTokens ?? "?"
              } reasoning=${usage?.reasoningTokens ?? "?"}`,
            )
          },
        }).toUIMessageStream({
          sendReasoning: true,
          onError: streamError,
        }),
      )
    },
  })

  const response = createUIMessageStreamResponse({ stream })

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
  sendRuntimeResponse(
    res,
    await handleSummaryRequest({
      body,
      model: resolveModel(modelFor(body.model)),
      call: callOptions,
      systemPrompt: config.summarySystemPrompt,
    }),
  )
}

const handleSummaryTitle = async (req, res, body) => {
  sendRuntimeResponse(
    res,
    await handleSummaryTitleRequest({
      body,
      model: resolveModel(modelFor(body.model)),
      call: callOptions,
      systemPrompt: config.titleSystemPrompt,
      log,
    }),
  )
}

const handleTranslationBatch = async (req, res, body) => {
  const entries = Array.isArray(body.entries) ? body.entries : []
  const fields = (Array.isArray(body.fields) ? body.fields : []).filter((field) =>
    TRANSLATABLE_FIELDS.includes(field),
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

  try {
    // Rows are written as they arrive, and the entries the model could not translate end up in the
    // terminal `{ failures }` row instead of disappearing from the reply.
    await runTranslationBatch({
      entries,
      fields,
      language: typeof body.language === "string" ? body.language : null,
      model: resolveModel(modelFor(body.model)),
      call: translationCallOptions,
      systemPrompt: config.translationSystemPrompt,
      concurrency: config.translationConcurrency,
      log,
      onRow: (row) => {
        res.write(`${JSON.stringify(row)}\n`)
      },
    })
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

    if (req.method === "POST" && pathname === "/ai/summary-title") {
      await handleSummaryTitle(req, res, await readJsonBody(req))
      return
    }

    if (req.method === "POST" && pathname === "/ai/translation/batch") {
      await handleTranslationBatch(req, res, await readJsonBody(req))
      return
    }

    sendJson(res, 404, { error: `Unsupported endpoint: ${req.method} ${pathname}` })
  } catch (error) {
    console.error("[gateway] request failed:", error)
    // A provider failure is not a request problem: the runtime decides what the status is (400 for
    // input it cannot use, 502 for the upstream, 500 for anything unexpected).
    if (!res.headersSent) {
      sendJson(res, statusForError(error), { error: errorMessage(error, "Internal error") })
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
