import { DEFAULT_RECOMMEND_FEEDS_SHORTCUT_ID } from "@follow/shared/settings/defaults"
import { isLocalAIEnabled } from "@follow/store/ai-local/config"
import { autoBindThis } from "@follow/utils/bind-this"
import { createDesktopAPIHeaders } from "@follow/utils/headers"
import PKG from "@pkg"
import type { ChatRequestOptions, ChatStatus } from "ai"
import { merge } from "es-toolkit/compat"
import { nanoid } from "nanoid"
import type { StateCreator } from "zustand"

import { getActionLanguage } from "~/atoms/settings/general"
import { followClient } from "~/lib/api-client"

import { AIPersistService } from "../../services"
import type { LocalAIFeedCandidate } from "../../utils/local-ai-context"
import { buildLocalAIContext, localAIContextQuestion } from "../../utils/local-ai-context"
import { extractShortcutIdFromMessageParts } from "../../utils/shortcut"
import { createChatTitleHandler, createChatTransport } from "../transport"
import type { BizUIMessage, SendingUIMessage } from "../types"
import { ZustandChat } from "./chat-instance"
import type { ChatSlice } from "./types"

const FEED_CANDIDATE_LIMIT = 40
const FEED_CANDIDATE_TTL = 10 * 60 * 1000
const FEED_CANDIDATE_CACHE_LIMIT = 20

/** Fetched per chat: the "recommend feeds" flow keeps asking on later turns. */
const feedCandidateCache = new Map<string, { at: number; feeds: LocalAIFeedCandidate[] }>()

/** Messages created from a shortcut carry its id as a prefix, which is cheap to check. */
const hasFeedRecommendationShortcutId = (message: { id?: string }) =>
  message.id?.startsWith(`${DEFAULT_RECOMMEND_FEEDS_SHORTCUT_ID}-`) ?? false

const asText = (value: unknown) => (typeof value === "string" && value.trim() ? value : null)

const loadFeedCandidates = async (chatId: string): Promise<LocalAIFeedCandidate[]> => {
  const cached = feedCandidateCache.get(chatId)
  if (cached && Date.now() - cached.at < FEED_CANDIDATE_TTL) return cached.feeds

  try {
    const { data } = await followClient.api.trending.getFeeds({ limit: FEED_CANDIDATE_LIMIT })
    const feeds = (data ?? [])
      .map((item) => ({
        id: asText(item.feed?.id) ?? asText(item.feedId) ?? "",
        title: asText(item.feed?.title),
        description: asText(item.feed?.description),
        url: asText(item.feed?.url),
      }))
      .filter((feed) => feed.id !== "")
      .slice(0, FEED_CANDIDATE_LIMIT)

    feedCandidateCache.set(chatId, { at: Date.now(), feeds })
    // Drop the oldest chats first: `Map` keeps insertion order.
    for (const key of feedCandidateCache.keys()) {
      if (feedCandidateCache.size <= FEED_CANDIDATE_CACHE_LIMIT) break
      feedCandidateCache.delete(key)
    }

    return feeds
  } catch (error) {
    console.warn(
      "[local-ai] could not load feed candidates for the recommend-feeds shortcut",
      error,
    )
    return []
  }
}

export class ChatSliceActions {
  // Hold reference to the most recently constructed (active) ChatSliceActions instance
  private static _current: ChatSliceActions | null = null

  /**
   * Get the currently active ChatSliceActions instance.
   *
   * WARNING: Anti-pattern — temporary global accessor used. Do NOT use in new code.
   * This may be removed/refactored.
   */
  static getActiveInstance(): ChatSliceActions | null {
    if (!this._current) return null
    return this._current
  }

  /**
   * See warning above — this setter exists solely for the same limited purpose.
   */
  static setActiveInstance(instance: ChatSliceActions | null) {
    this._current = instance
  }

  // Every mounted chat, so a settings change repoints all of them, not only the last mount.
  private static _instances = new Set<ChatSliceActions>()

  static registerInstance(instance: ChatSliceActions) {
    this._instances.add(instance)
  }

  static unregisterInstance(instance: ChatSliceActions) {
    this._instances.delete(instance)
  }

  /** Rebuilds the transport of every mounted chat, e.g. after the gateway settings changed. */
  static recreateTransportEverywhere() {
    for (const instance of this._instances) {
      instance.recreateTransport()
    }
  }

  private chatInstance: ZustandChat
  constructor(
    private params: Parameters<StateCreator<ChatSlice, [], [], ChatSlice>>,

    options: {
      chatInstance: ZustandChat
      hasChatId: boolean
    },
  ) {
    if (options.hasChatId) {
      options.chatInstance.resumeStream()
    }
    this.chatInstance = options.chatInstance
    return autoBindThis(this)
  }

  get set() {
    return this.params[0]
  }

  get get() {
    return this.params[1]
  }

  private computeSyncStatus(isLocal: boolean): "local" | "synced" {
    return isLocal ? "local" : "synced"
  }

  private setSyncState(isLocal: boolean) {
    this.set((state) => {
      const nextStatus = this.computeSyncStatus(isLocal)
      if (state.isLocal === isLocal && state.syncStatus === nextStatus) {
        return state
      }
      return {
        isLocal,
        syncStatus: nextStatus,
      }
    })
  }

  async markSessionSynced() {
    // A gateway keeps sessions in the local database only, so a local session must stay local:
    // Folo's backend knows nothing about it and the next sync would look for a missing session.
    if (isLocalAIEnabled()) {
      return
    }

    const currentChatId = this.get().chatId
    if (!currentChatId) {
      return
    }

    if (!this.get().isLocal) {
      return
    }

    this.setSyncState(false)

    try {
      await AIPersistService.markSessionSynced(currentChatId)
    } catch (error) {
      console.error("Failed to mark chat session as synced:", error)
    }
  }

  // Direct message management methods (delegating to chat instance state)
  setMessages = (
    messagesParam: BizUIMessage[] | ((messages: BizUIMessage[]) => BizUIMessage[]),
  ) => {
    if (typeof messagesParam === "function") {
      this.chatInstance.chatState.messages = messagesParam(this.chatInstance.chatState.messages)
    } else {
      this.chatInstance.chatState.messages = messagesParam
    }
  }

  pushMessage = (message: BizUIMessage) => {
    this.chatInstance.chatState.pushMessage(message)
  }

  popMessage = () => {
    this.chatInstance.chatState.popMessage()
  }

  replaceMessage = (index: number, message: BizUIMessage) => {
    this.chatInstance.chatState.replaceMessage(index, message)
  }

  updateMessage = (id: string, updates: Partial<BizUIMessage>) => {
    const messageIndex = this.chatInstance.chatState.messages.findIndex(
      (msg: BizUIMessage) => msg.id === id,
    )
    if (messageIndex !== -1) {
      const message = this.chatInstance.chatState.messages[messageIndex]
      if (message) {
        const updatedMessage = { ...message, ...updates }
        this.replaceMessage(messageIndex, updatedMessage)
      }
    }
  }

  // Getter
  getChatInstance = (): ZustandChat => {
    return this.chatInstance
  }

  getMessages = (): BizUIMessage[] => {
    return this.chatInstance.chatState.messages
  }

  // Status management (delegating to chat instance state)
  setStatus = (status: ChatStatus) => {
    this.chatInstance.chatState.status = status
  }

  setError = (error: Error | undefined) => {
    this.chatInstance.chatState.error = error
  }

  setStreaming = (streaming: boolean) => {
    this.chatInstance.chatState.status = streaming ? "streaming" : "ready"
  }

  // Title management
  setCurrentTitle = (title: string | undefined) => {
    this.set((state) => ({ ...state, currentTitle: title }))
  }

  getCurrentTitle = (): string | undefined => {
    return this.get().currentTitle
  }

  getCurrentChatId = (): string | null => {
    return this.get().chatId
  }

  private createTransportTitleHandler = (chatId: string) => {
    return createChatTitleHandler({
      chatId,
      getActiveChatId: () => this.get().chatId,
      onTitleChange: (title) => {
        this.setCurrentTitle(title)
      },
    })
  }

  // Edit chat title
  editChatTitle = async (newTitle: string) => {
    const currentChatId = this.getCurrentChatId()
    if (!currentChatId) {
      throw new Error("No active chat to edit title for")
    }

    const trimmedTitle = newTitle.trim()
    const currentTitle = this.getCurrentTitle()

    // If no changes, return early
    if (trimmedTitle === currentTitle) {
      return
    }

    try {
      // Optimistic update
      this.setCurrentTitle(trimmedTitle)

      // Persist to database
      await AIPersistService.updateSessionTitle(currentChatId, trimmedTitle)
    } catch (error) {
      // Rollback on error
      this.setCurrentTitle(currentTitle)
      console.error("Failed to update chat title:", error)
      throw error
    }
  }

  // Core chat actions using AI SDK AbstractChat methods
  sendMessage = async (message: string | SendingUIMessage, options?: ChatRequestOptions) => {
    try {
      // Convert string to message object if needed
      const messageObj =
        typeof message === "string"
          ? ({ parts: [{ type: "text", text: message }] } as Parameters<
              typeof this.chatInstance.sendMessage
            >[0])
          : (message as Parameters<typeof this.chatInstance.sendMessage>[0])

      // A self-hosted gateway cannot resolve the ids in the context blocks, nor the timeline a
      // shortcut points at, so everything it needs travels with the request.
      const localAIContext =
        isLocalAIEnabled() && messageObj?.parts
          ? await this.createLocalAIContext({
              id: messageObj.id,
              parts: messageObj.parts as BizUIMessage["parts"],
            })
          : null

      // Use the AI SDK's sendMessage method
      const finalOptions = merge(
        {
          body: {
            scene: this.get().scene,
            ...(localAIContext ? { localAIContext } : {}),
            // A local model has no access to the interface language, so the request carries it.
            ...(isLocalAIEnabled() ? { language: getActionLanguage() } : {}),
          },
          headers: createDesktopAPIHeaders({ version: PKG.version }),
        },
        options,
      )

      return await this.chatInstance.sendMessage(messageObj, finalOptions)
    } catch (error) {
      this.setError(error as Error)
      throw error
    }
  }

  /**
   * Builds the payload a local gateway needs: the entries behind the context blocks, the timeline
   * a date mention points at, and the feed catalogue the "recommend feeds" shortcut picks from.
   */
  private createLocalAIContext = async (message: { id?: string; parts: BizUIMessage["parts"] }) => {
    if (!isLocalAIEnabled()) return null

    const question = localAIContextQuestion(message.parts)
    // The catalogue has to stay attached for the follow-up turns of that conversation too, so the
    // whole conversation is checked — by id prefix, which costs nothing; the editor state is only
    // parsed for the message being sent.
    const needsFeedCandidates =
      hasFeedRecommendationShortcutId(message) ||
      this.getMessages().some(hasFeedRecommendationShortcutId) ||
      extractShortcutIdFromMessageParts(message.parts as SendingUIMessage["parts"]) ===
        DEFAULT_RECOMMEND_FEEDS_SHORTCUT_ID
    const feedCandidates = needsFeedCandidates
      ? await loadFeedCandidates(this.get().chatId)
      : undefined

    return buildLocalAIContext(message.parts, { question, feedCandidates })
  }

  /** The user message a regenerate request belongs to, so the local context matches it. */
  private getUserMessage(messageId: string): BizUIMessage | null {
    const messages = this.getMessages()
    const index = messages.findIndex((message) => message.id === messageId)

    // `messageId` normally points at the assistant answer; the question is the user message
    // before it (or the message itself when the user message is regenerated).
    if (index !== -1 && messages[index]?.role === "user") {
      return messages[index]
    }

    for (let i = (index === -1 ? messages.length : index) - 1; i >= 0; i--) {
      const message = messages[i]
      if (message?.role === "user") return message
    }

    return null
  }

  regenerate = async ({ messageId, ...options }: { messageId: string } & ChatRequestOptions) => {
    try {
      // Regenerating must ship the same local context as the original send; the gateway has no
      // server-side history to replay it from.
      const userMessage = isLocalAIEnabled() ? this.getUserMessage(messageId) : null
      const localAIContext = userMessage ? await this.createLocalAIContext(userMessage) : null

      // Use the AI SDK's regenerate method
      const finalOptions = merge(
        {
          body: {
            scene: this.get().scene,
            ...(localAIContext ? { localAIContext } : {}),
            ...(isLocalAIEnabled() ? { language: getActionLanguage() } : {}),
          },
        },
        options,
      )
      return await this.chatInstance.regenerate({ messageId, ...finalOptions })
    } catch (error) {
      this.setError(error as Error)
      throw error
    }
  }

  stop = () => {
    // Use AI SDK's stop method
    this.chatInstance.stop()
  }

  resumeStream = async () => {
    try {
      // Use AI SDK's resumeStream method
      await this.chatInstance.resumeStream()
    } catch (error) {
      this.setError(error as Error)
      throw error
    }
  }

  resetChat = () => {
    // Reset through the chat instance state
    this.chatInstance.chatState.messages = []
    this.chatInstance.chatState.error = undefined
    this.chatInstance.chatState.status = "ready"
    // Reset title
    this.setCurrentTitle(undefined)
  }

  private isStreaming = () => {
    const { status } = this.get()
    return status === "streaming" || status === "submitted"
  }

  private applyTransportRebuild = () => {
    this.chatInstance.setTransport(
      createChatTransport({
        titleHandler: this.createTransportTitleHandler(this.get().chatId),
      }),
    )
  }

  /**
   * Points the running chat at the current endpoint, e.g. after the gateway settings changed.
   * A stream that is already running keeps the transport it started with, so the rebuild waits
   * for it to finish instead of cutting the answer off; the next request then uses the new one.
   */
  private pendingTransportRebuild = false

  recreateTransport = () => {
    if (!this.isStreaming()) {
      this.applyTransportRebuild()
      return
    }

    // Rebuilds scheduled while a stream runs all build the same transport, so keep one.
    if (this.pendingTransportRebuild) return
    this.pendingTransportRebuild = true

    const unsubscribe = this.params[2].subscribe(() => {
      if (this.isStreaming()) return

      this.pendingTransportRebuild = false
      unsubscribe()
      this.applyTransportRebuild()
    })
  }

  newChat = async () => {
    const newChatId = nanoid()
    // Cleanup old chat instance
    await this.chatInstance.destroy()

    // Create new chat instance
    const newChatInstance = new ZustandChat(
      {
        id: newChatId,
        messages: [],
        transport: createChatTransport({
          titleHandler: this.createTransportTitleHandler(newChatId),
        }),
      },
      this.set,
    )

    // Update store state
    this.set((state) => ({
      ...state,
      chatId: newChatId,
      messages: [],
      status: "ready" as ChatStatus,
      error: undefined,
      isStreaming: false,
      currentTitle: undefined,
      chatInstance: newChatInstance,
      isLocal: true,
      syncStatus: "local",
    }))

    // Update the reference
    this.chatInstance = newChatInstance
  }

  switchToChat = async (chatId: string) => {
    try {
      // Cleanup old chat instance
      await this.chatInstance.destroy()
      // Set loading state (using ready as there's no loading status in ChatStatus)
      this.setStatus("ready")
      this.setError(undefined)

      // Load session and messages in parallel to reduce database queries
      const { session: chatSession, messages } =
        await AIPersistService.loadSessionWithMessages(chatId)

      // Create new chat instance with loaded messages
      const newChatInstance = new ZustandChat(
        {
          id: chatId,
          messages,
          transport: createChatTransport({
            titleHandler: this.createTransportTitleHandler(chatId),
          }),
        },
        this.set,
      )

      // Update store state
      this.set((state) => ({
        ...state,
        chatId,
        messages: [...messages],
        status: "ready" as ChatStatus,
        error: undefined,
        isStreaming: false,
        currentTitle: chatSession?.title || undefined,
        chatInstance: newChatInstance,
        isLocal: chatSession ? chatSession.isLocal : true,
        syncStatus: chatSession ? chatSession.syncStatus : "local",
      }))

      await newChatInstance.resumeStream()
      // Update the reference
      this.chatInstance = newChatInstance
    } catch (error) {
      console.error("Failed to switch to chat:", error)
      this.setError(error as Error)
      this.setStatus("ready")
      throw error
    }
  }

  setScene = (scene: ChatSlice["scene"]) => {
    this.set((state) => ({ ...state, scene }))
  }

  setTimelineSummaryManualOverride = (override: boolean) => {
    this.set((state) => {
      if (state.timelineSummaryManualOverride === override) {
        return state
      }
      return { ...state, timelineSummaryManualOverride: override }
    })
  }

  getTimelineSummaryManualOverride = () => {
    return this.get().timelineSummaryManualOverride
  }

  setTimelineSummaryWasInAutoContext = (isInAutoContext: boolean) => {
    this.set((state) => {
      if (state.timelineSummaryWasInAutoContext === isInAutoContext) {
        return state
      }
      return { ...state, timelineSummaryWasInAutoContext: isInAutoContext }
    })
  }

  getTimelineSummaryWasInAutoContext = () => {
    return this.get().timelineSummaryWasInAutoContext
  }
}
