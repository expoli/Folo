import type {
  LocalAIChatStreamEvent,
  LocalAIChatStreamOpenResult,
  LocalAIDirectConfig,
  LocalAIHttpResponse,
  LocalAIRequestInput,
} from "@follow/shared/settings/local-ai"
import { LOCAL_AI_CHAT_STREAM_CHANNEL } from "@follow/shared/settings/local-ai"

import { ipcServices } from "~/lib/client"

/**
 * `direct` mode transport.
 *
 * The renderer has no access to the API key, so the requests the shared store layer sends are
 * handed to the main process over IPC. The returned fetch produces real `Response` objects, which
 * lets `HttpChatTransport` and `readNdjsonStream` stay unchanged.
 */

/** Statuses a `Response` must not carry a body for. */
const BODY_NULL_STATUSES = new Set([101, 204, 205, 304])

const requireServices = () => {
  if (!ipcServices) {
    throw new Error("Local AI direct mode needs the desktop app")
  }

  return ipcServices
}

const toResponse = (payload: LocalAIHttpResponse) =>
  new Response(BODY_NULL_STATUSES.has(payload.status) ? null : payload.body, {
    status: payload.status,
    headers: payload.headers,
  })

const requestDirectPath = async (input: LocalAIRequestInput) =>
  toResponse(await requireServices().localAI.request(input))

const openDirectChatStream = async (input: LocalAIRequestInput, signal?: AbortSignal | null) => {
  const services = requireServices()
  const ipcRenderer = window.electron?.ipcRenderer

  if (!ipcRenderer) {
    throw new Error("Local AI direct mode needs the desktop app")
  }

  const encoder = new TextEncoder()
  /** Events that arrived before the stream above could subscribe (see below). */
  const earlyEvents: LocalAIChatStreamEvent[] = []
  let streamId: string | null = null
  let deliver: ((event: LocalAIChatStreamEvent) => void) | null = null
  let finished = false
  /** Detaches the abort listener of this stream; see `finish`. */
  let detachAbort: (() => void) | null = null

  // Subscribe before opening the stream: the main process starts pushing as soon as it answers,
  // and `ipcRenderer.on` does not buffer, so subscribing afterwards could drop the first chunk.
  const unsubscribe = ipcRenderer.on(
    LOCAL_AI_CHAT_STREAM_CHANNEL,
    (_event: unknown, event: LocalAIChatStreamEvent) => {
      if (finished) return

      if (deliver) {
        // Live: only this chat's events matter; the rest belong to other streams.
        if (event.streamId === streamId) deliver(event)
        return
      }

      earlyEvents.push(event)
    },
  )

  /** Stops listening, and tells the main process to stop generating when the chat was aborted. */
  const finish = (abortUpstream: boolean) => {
    if (finished) return false

    finished = true
    // The signal outlives this stream (one chat request per signal), so its listener is removed
    // instead of staying attached for the next request of the same chat.
    detachAbort?.()
    detachAbort = null
    unsubscribe?.()
    deliver = null
    if (abortUpstream && streamId) void services.localAI.closeChatStream({ streamId })
    return true
  }

  let opened: LocalAIChatStreamOpenResult
  try {
    opened = await services.localAI.openChatStream({ body: input.body, config: input.config })
  } catch (error) {
    unsubscribe?.()
    throw error
  }

  const headers = new Headers(opened.headers)

  // A rejected request (no message text, no model configured, …) answers in one piece.
  if (!opened.streamId) {
    unsubscribe?.()
    return new Response(opened.body ?? "", { status: opened.status, headers })
  }

  streamId = opened.streamId

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const abort = () => {
        if (finish(true)) {
          controller.error(new DOMException("The chat request was aborted", "AbortError"))
        }
      }

      detachAbort = () => signal?.removeEventListener("abort", abort)

      if (signal?.aborted) {
        abort()
        return
      }

      signal?.addEventListener("abort", abort, { once: true })

      deliver = (event: LocalAIChatStreamEvent) => {
        if ("chunk" in event) {
          controller.enqueue(encoder.encode(event.chunk))
          return
        }

        finish(false)
        if ("error" in event) {
          controller.error(new Error(event.error))
        } else {
          controller.close()
        }
      }

      // Replay whatever arrived while the stream was being set up, keeping only this stream.
      for (const event of earlyEvents.splice(0)) {
        if (finished) break
        if (event.streamId !== streamId) continue
        deliver(event)
      }
    },
    cancel() {
      finish(true)
    },
  })

  return new Response(stream, { status: opened.status, headers })
}

/**
 * Fetch implementation of `direct` mode. The config is read per request, so editing the endpoint
 * in Settings → AI takes effect on the next request without rebuilding the transport.
 */
export const createLocalAIDirectFetch = (
  getConfig: () => LocalAIDirectConfig | null,
): typeof globalThis.fetch =>
  async function localAIDirectFetch(input, init) {
    const config = getConfig()
    if (!config) {
      throw new Error("No direct AI endpoint is configured")
    }

    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const { pathname, search } = new URL(url)
    const requestInput: LocalAIRequestInput = {
      path: `${pathname}${search}`,
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body == null ? null : String(init.body),
      config,
    }

    if (requestInput.method === "POST" && pathname === "/ai/chat") {
      return openDirectChatStream(requestInput, init?.signal)
    }

    return requestDirectPath(requestInput)
  }
