import { randomUUID } from "node:crypto"

import type { LocalAIChatStreamEvent } from "@follow/shared/settings/local-ai"

/**
 * Bridges one upstream SSE response to the renderer as a sequence of text chunks.
 *
 * The chat reply is the only streamed answer of the local AI contract; everything else is
 * requested and answered in one piece. Chunks are decoded with a single streaming decoder so a
 * multi-byte character split across two network chunks cannot be mangled.
 */

const MAX_ERROR_CHARS = 300

interface OpenChatStreamParams {
  /** Upstream SSE response; a response without a body is reported as "no stream". */
  response: Response
  /** Aborts the upstream model call. */
  abortController: AbortController
  /** Pushes one event to the renderer that opened the stream. */
  send: (event: LocalAIChatStreamEvent) => void
  /** Called once the stream is over, whether it finished, failed or was cancelled. */
  onFinish?: () => void
}

const openStreams = new Map<string, AbortController>()

export const openChatStream = (params: OpenChatStreamParams): string | null => {
  const { response, abortController, send } = params
  if (!response.body) return null

  const streamId = randomUUID()
  openStreams.set(streamId, abortController)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        if (chunk) send({ streamId, chunk })
      }

      send({ streamId, done: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      send({ streamId, error: message.slice(0, MAX_ERROR_CHARS) })
    } finally {
      openStreams.delete(streamId)
      reader.releaseLock()
      params.onFinish?.()
    }
  })()

  return streamId
}

/** Called when the renderer aborts the chat (stop button, closing the chat): stops the model. */
export const cancelChatStream = (streamId: string) => {
  const abortController = openStreams.get(streamId)
  if (!abortController) return false

  openStreams.delete(streamId)
  abortController.abort()
  return true
}
