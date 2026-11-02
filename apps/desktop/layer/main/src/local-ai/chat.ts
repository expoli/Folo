import { reduceChatContext } from "@follow/ai-runtime/chat"
import type { LocalAIContext } from "@follow/ai-runtime/context"
import {
  buildChatSystemPrompt,
  describeChatContext,
  formatLocalContext,
  toModelMessages,
} from "@follow/ai-runtime/context"
import { errorMessage, statusForError } from "@follow/ai-runtime/errors"
import { jsonResponse } from "@follow/ai-runtime/http"
import { DEFAULT_CHAT_SYSTEM_PROMPT } from "@follow/ai-runtime/prompts"
import {
  createDirectModel,
  DIRECT_CONTEXT_BUDGET,
  directCallOptions,
  resolveModelId,
} from "@follow/ai-runtime/provider"
import { noteCacheKey } from "@follow/ai-runtime/reduce"
import type { LocalAIDirectConfig } from "@follow/shared/settings/local-ai"
import type { UIMessage, UIMessageChunk } from "ai"
import { createUIMessageStream, createUIMessageStreamResponse, stepCountIs, streamText } from "ai"
import { app } from "electron"
import { join } from "pathe"

import {
  applyFetchedTexts,
  collectFetchTargets,
  fetchArticleText,
  fetchArticleTexts,
  promptText,
} from "./article-text"
import { netFetch } from "./http"
import { createLocalAIMcpTools } from "./mcp"
import type { NotesCache } from "./notes-cache"
import { createNotesCache } from "./notes-cache"
import {
  createLocalAITools,
  getReadingToolHandlers,
  isToolRejectionError,
  isToolSupportRejected,
  LOCAL_AI_MAX_TOOL_STEPS,
  localAIToolSupportKey,
  markToolSupportRejected,
} from "./tools"
import { scopeFromContext, withDefaultScope } from "./tools/scope"

const NOTES_CACHE_FILE = "local-ai-notes.json"

let notesCache: NotesCache | undefined

/** The one error shape both the model stream and the outer stream answer with. */
const streamError = (error: unknown) => {
  console.error("[local-ai] chat stream error:", error)
  return error instanceof Error ? error.message : "Local AI error"
}

/**
 * Notes of earlier summaries, kept for the life of the app and across restarts. Without an Electron
 * runtime (unit tests) they simply stay in memory, and a summary re-reads the articles instead.
 */
const getNotesCache = (): NotesCache => {
  if (notesCache) return notesCache

  try {
    notesCache = createNotesCache({ file: join(app.getPath("userData"), NOTES_CACHE_FILE) })
  } catch {
    notesCache = createNotesCache()
  }

  return notesCache
}

interface ChatRequestBody {
  messages?: unknown
  model?: unknown
  localAIContext?: LocalAIContext
  /** Interface language of the app, so the answer matches it instead of the prompt's language. */
  language?: unknown
  /** Which shortcut sent this; a timeline summary already reads its articles in the reduce pass. */
  scene?: unknown
  /** Enabled MCP services of the user, as the settings keep them (`LocalAIMcpService`). */
  mcpServices?: unknown
}

/**
 * Answers `POST /ai/chat` with an AI SDK UI message stream, the same shape `HttpChatTransport`
 * expects from Folo's own API and from a self-hosted gateway.
 *
 * The prompt itself (context, notes pre-pass, coverage) comes from `@follow/ai-runtime`; what stays
 * here is what only this process can do: the API key custody, Chromium's network stack, the
 * encrypted notes file and the IPC stream bridge.
 */
export const createChatStreamResponse = async (params: {
  body: ChatRequestBody
  config: LocalAIDirectConfig
  apiKey: string | null
  abortSignal?: AbortSignal
}): Promise<Response> => {
  const { body, config, apiKey, abortSignal } = params
  const messages = await toModelMessages(body.messages)
  if (messages.length === 0) {
    return jsonResponse(400, { error: "No message text found in the request" })
  }

  const stats = describeChatContext(body.localAIContext)
  const requestedModel = typeof body.model === "string" ? body.model : null
  const language = typeof body.language === "string" ? body.language : null
  const scene = typeof body.scene === "string" ? body.scene : null
  const call = directCallOptions(config)
  // The model that actually runs, not the one the client asked for: a requested model outside the
  // configured list silently falls back, and its notes must not be reused as the other's.
  const modelId = resolveModelId(config, requestedModel) || requestedModel || config.model

  // A summary already reads every matched article in the reduce pre-pass; giving it tools as well
  // would let one shortcut spend an unbounded number of requests. `null` handlers mean this process
  // never bound the reading service (tests, a build without it): the chat then simply has no tools.
  const toolKey = localAIToolSupportKey({ baseUrl: config.baseUrl, model: modelId })
  const handlers = getReadingToolHandlers()
  const toolsAllowed = scene !== "timeline-summary" && !isToolSupportRejected(toolKey)

  console.log(
    `[local-ai] chat: model=${requestedModel ?? config.model} messages=${messages.length} ` +
      `context=${stats.blocks} block(s)/${stats.entries} entrie(s)(${stats.withText} with text + ` +
      `${stats.reduceTexts} for reduce)/${stats.matched} matched/window=${stats.window || "none"}/${
        stats.feeds
      } feed(s)/${stats.contextChars} chars${stats.selection ? ` [${stats.selection}]` : ""} ` +
      `tools=${toolsAllowed ? "requested" : "off"}${scene ? ` scene=${scene}` : ""}`,
  )

  let model
  try {
    model = createDirectModel({ config, apiKey, fetch: netFetch, requestedModel })
  } catch (error) {
    return jsonResponse(statusForError(error), {
      error: errorMessage(error, "No model is configured for the direct endpoint"),
    })
  }

  // The user's MCP services are opened per chat, after the model is known to work: a request that
  // cannot run must not leave connections behind.
  const mcp = toolsAllowed
    ? await createLocalAIMcpTools(body.mcpServices, {
        fetch: netFetch,
        signal: abortSignal,
        log: (line) => console.log(line),
      })
    : null
  const tools = {
    ...(toolsAllowed && handlers
      ? createLocalAITools(withDefaultScope(handlers, scopeFromContext(body.localAIContext)))
      : {}),
    ...(mcp?.tools ?? {}),
  }
  const hasTools = Object.keys(tools).length > 0
  // A tool whose server did not claim it is read-only only runs after the user says so in the
  // panel. That decision arrives with the next request, so one approval costs one more chat round
  // trip and starts its own step budget.
  const toolApproval = mcp && Object.keys(mcp.approvals).length > 0 ? mcp.approvals : undefined
  const closeTools = () => {
    void mcp?.close()
  }
  // An aborted chat still has to release its MCP sessions; `onEnd` covers the normal path.
  abortSignal?.addEventListener("abort", closeTools, { once: true })

  const stream = createUIMessageStream({
    // The history the client sent is the message the answer belongs to: an approved tool result is
    // only attachable if the assembler can see the tool call it answers.
    ...(Array.isArray(body.messages) ? { originalMessages: body.messages as UIMessage[] } : {}),
    // Both streams report their model errors the same way: the inner one would otherwise answer
    // with the SDK's generic "An error occurred.".
    onError: streamError,
    onEnd: () => {
      abortSignal?.removeEventListener("abort", closeTools)
      closeTools()
    },
    execute: async ({ writer }) => {
      let context = body.localAIContext ?? null
      const notes = getNotesCache()

      // A summary is only as good as what it reads. The client marks the requests whose articles
      // are worth fetching (the ones it also sends for the reduce pre-pass); the pass is bounded,
      // best effort, and every failure leaves the entry with the text it arrived with.
      if (context?.fetchBodies === true && Array.isArray(context.entries)) {
        // Bound once: the narrowing of `context` does not survive into the callbacks below.
        const contextEntries = context.entries
        // An article that already has a note is left alone: reading it again would change the text
        // the note is keyed by, so the note would be paid for twice and never reused.
        const targets = collectFetchTargets(contextEntries).filter((target) => {
          const entry = contextEntries[target.index - 1]
          const body = typeof entry?.body === "string" ? entry.body : ""
          if (!body) return true

          const title = typeof entry?.title === "string" ? entry.title : null
          return !notes.get(noteCacheKey({ modelId, language, title, body }))
        })
        if (targets.length > 0) {
          console.log(
            `[local-ai] fetch: reading ${targets.length} article(s) that only carry an excerpt…`,
          )
          const fetched = await fetchArticleTexts({
            targets,
            // Passed in rather than defaulted, so the fetcher of one request is one visible thing.
            fetchText: fetchArticleText,
            signal: abortSignal,
            log: (line) => console.log(`[local-ai] ${line}`),
            onProgress: (done, total) => {
              writer.write({
                type: "data-reduce-progress",
                id: "reduce-progress",
                data: { phase: "fetch", done, total },
              })
            },
          })

          // A verbatim entry keeps its place in the prompt, within its share of what is left of
          // the announced budget: what the entries that were not fetched already carry is spent.
          const targetIndexes = new Set(targets.map((target) => target.index))
          const isFetchedVerbatim = (entry: (typeof contextEntries)[number], position: number) =>
            typeof entry.content === "string" && !!entry.content && targetIndexes.has(position + 1)
          const carried = contextEntries.reduce(
            (sum, entry, position) =>
              typeof entry.content === "string" && entry.content && !targetIndexes.has(position + 1)
                ? sum + entry.content.length
                : sum,
            0,
          )
          const fetchedVerbatim = contextEntries.filter(isFetchedVerbatim).length
          const verbatimChars = Math.min(
            DIRECT_CONTEXT_BUDGET.maxCharsPerEntry,
            Math.floor(
              Math.max(0, DIRECT_CONTEXT_BUDGET.maxTotalChars - carried) /
                Math.max(1, fetchedVerbatim),
            ),
          )
          const applied = applyFetchedTexts(contextEntries, fetched.texts, { verbatimChars })
          if (applied > 0) {
            console.log(`[local-ai] fetch: ${applied} entrie(s) now carry their article text`)
          }
        }
      }

      // The prompt reads sentences, not markup: an article that was opened earlier arrives as HTML.
      if (context?.entries) {
        context = {
          ...context,
          entries: context.entries.map((entry) => ({
            ...entry,
            ...(typeof entry.content === "string" && entry.content
              ? { content: promptText(entry.content) }
              : {}),
            ...(typeof entry.body === "string" && entry.body
              ? { body: promptText(entry.body) }
              : {}),
          })),
        }
      }

      const reduced = await reduceChatContext({
        context,
        model,
        modelId,
        language,
        call,
        notes,
        log: (line) => console.log(`[local-ai] ${line}`),
        signal: abortSignal,
        onProgress: (done, total) => {
          // One id, so every update replaces the previous line instead of stacking a part per batch.
          writer.write({
            type: "data-reduce-progress",
            id: "reduce-progress",
            data: { phase: "summarise", done, total },
          })
        },
      })

      const localContext = formatLocalContext(reduced.context)
      if (localContext === "") {
        console.warn(
          "[local-ai] chat: no localAIContext arrived, so the model cannot see the Folo entries " +
            "(the client attaches them only when local AI is enabled and the chat has context blocks)",
        )
      }

      const pipeReply = async (useTools: boolean) => {
        // Keep only the envelope until the model produces something. A rejected initial tools
        // request can then be replaced without emitting a failed message or replaying tool work.
        const prefix: UIMessageChunk[] = []
        let committed = false
        let toolRejected = false
        let retryWithoutTools = false
        const reply = streamText({
          model,
          system: buildChatSystemPrompt(DEFAULT_CHAT_SYSTEM_PROMPT, localContext, language, {
            toolsAvailable: useTools,
          }),
          messages,
          maxOutputTokens: call.maxOutputTokens,
          temperature: call.temperature,
          providerOptions: call.providerOptions,
          abortSignal,
          ...(useTools
            ? {
                tools,
                stopWhen: stepCountIs(LOCAL_AI_MAX_TOOL_STEPS),
                ...(toolApproval ? { toolApproval } : {}),
              }
            : {}),
          onFinish: ({ finishReason, usage }) => {
            console.log(
              `[local-ai] chat done: finish=${finishReason ?? "?"} output=${
                usage?.outputTokens ?? "?"
              } reasoning=${usage?.outputTokenDetails?.reasoningTokens ?? "?"}`,
            )
          },
        }).toUIMessageStream({
          sendReasoning: true,
          onError: (error) => {
            if (useTools && isToolRejectionError(error)) {
              markToolSupportRejected(toolKey)
              toolRejected = true
              return errorMessage(error, "The endpoint rejected tool calling")
            }
            return streamError(error)
          },
        })

        for await (const chunk of reply) {
          if (chunk.type === "error" && toolRejected && !committed && !abortSignal?.aborted) {
            retryWithoutTools = true
            console.warn(`[local-ai] chat: ${modelId} rejected tools; retrying without them`)
          }
          if (retryWithoutTools) continue
          if (!committed && (chunk.type === "start" || chunk.type === "start-step")) {
            prefix.push(chunk)
            continue
          }

          if (!committed) {
            committed = true
            for (const pending of prefix) writer.write(pending)
          }
          writer.write(chunk)
        }

        return retryWithoutTools
      }

      if (await pipeReply(hasTools)) {
        closeTools()
        await pipeReply(false)
      }
    },
  })

  return createUIMessageStreamResponse({ stream })
}

/** `GET /ai/chat/:id/stream` has no server-side history to resume; always "no active stream". */
export const createStreamResumeResponse = () => new Response(null, { status: 204 })
