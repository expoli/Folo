import type {
  LocalAIChatStreamInput,
  LocalAIChatStreamOpenResult,
  LocalAIDirectConfig,
  LocalAIHttpResponse,
  LocalAIRequestInput,
  LocalAISetApiKeyResult,
} from "@follow/shared/settings/local-ai"
import { LOCAL_AI_CHAT_STREAM_CHANNEL } from "@follow/shared/settings/local-ai"
import { getIpcContext, IpcMethod, IpcService } from "electron-ipc-decorator"

import { createChatStreamResponse } from "../../local-ai/chat"
import {
  clearApiKey,
  hasApiKey,
  isSecureStorageAvailable,
  readApiKey,
  writeApiKey,
} from "../../local-ai/credentials"
import { parseJsonBody } from "../../local-ai/http"
import {
  fetchUpstreamModelIds,
  resetModelListCache,
  routeLocalAIRequest,
} from "../../local-ai/routes"
import { cancelChatStream, openChatStream } from "../../local-ai/streams"

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Local AI request failed"

const toHttpResponse = async (response: Response): Promise<LocalAIHttpResponse> => ({
  status: response.status,
  headers: Object.fromEntries(response.headers.entries()),
  body: await response.text(),
})

/**
 * Local AI IPC surface of the desktop app.
 *
 * It serves the same paths a self-hosted gateway serves (`/ai/chat`, `/ai/chat/config`,
 * `/ai/summary`, `/ai/translation/batch`, `/health`), so the shared store layer needs no second
 * code path. The API key of the endpoint stays in the main process: it is read from the encrypted
 * store per request and never travels to the renderer.
 */
export class LocalAIService extends IpcService {
  static override readonly groupName = "localAI"

  @IpcMethod()
  hasApiKey(): boolean {
    return hasApiKey()
  }

  @IpcMethod()
  isSecureStorageAvailable(): boolean {
    return isSecureStorageAvailable()
  }

  @IpcMethod()
  setApiKey(key: string): LocalAISetApiKeyResult {
    const result = writeApiKey(key)
    // A rejected key may sit in the model-list cache; the user has just replaced it.
    if (result.ok) resetModelListCache()
    return result
  }

  @IpcMethod()
  clearApiKey(): void {
    clearApiKey()
    resetModelListCache()
  }

  /** Model list of the configured endpoint, for the "fetch models" button in the settings. */
  @IpcMethod()
  async listModels(input: { config: LocalAIDirectConfig }): Promise<string[]> {
    const { ids, rejected } = await fetchUpstreamModelIds(input.config, readApiKey())
    if (rejected) {
      throw new Error("The endpoint rejected the API key")
    }

    return ids
  }

  /** Serves summary / translation / chat-config / health in one piece. */
  @IpcMethod()
  async request(input: LocalAIRequestInput): Promise<LocalAIHttpResponse> {
    const response = await routeLocalAIRequest({ ...input, apiKey: readApiKey() })
    return toHttpResponse(response)
  }

  /** Opens the streamed chat reply; chunks arrive on `LOCAL_AI_CHAT_STREAM_CHANNEL`. */
  @IpcMethod()
  async openChatStream(input: LocalAIChatStreamInput): Promise<LocalAIChatStreamOpenResult> {
    const abortController = new AbortController()

    let body: Record<string, unknown>
    try {
      body = parseJsonBody(input.body)
    } catch (error) {
      return {
        streamId: null,
        status: 400,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: errorMessage(error) }),
      }
    }

    const response = await createChatStreamResponse({
      body,
      config: input.config,
      apiKey: readApiKey(),
      abortSignal: abortController.signal,
    })
    const headers = Object.fromEntries(response.headers.entries())

    if (!response.ok || !response.body) {
      return { streamId: null, status: response.status, headers, body: await response.text() }
    }

    const sender = getIpcContext().sender
    // A window that goes away mid-answer must not keep the model generating.
    const abortOnDestroy = () => abortController.abort()
    sender.once("destroyed", abortOnDestroy)

    const streamId = openChatStream({
      response,
      abortController,
      send: (event) => {
        if (!sender.isDestroyed()) {
          this.handler.sendToRenderer(sender, LOCAL_AI_CHAT_STREAM_CHANNEL, event)
        }
      },
      onFinish: () => sender.off("destroyed", abortOnDestroy),
    })

    if (!streamId) {
      return {
        streamId: null,
        status: 500,
        headers,
        body: JSON.stringify({ error: "The model returned no stream" }),
      }
    }

    return { streamId, status: response.status, headers, body: null }
  }

  @IpcMethod()
  closeChatStream(input: { streamId: string }): boolean {
    return cancelChatStream(input.streamId)
  }
}
