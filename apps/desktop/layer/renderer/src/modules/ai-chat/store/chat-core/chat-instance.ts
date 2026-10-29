import type { ChatInit, ChatStatus, ChatTransport } from "ai"
import { AbstractChat, lastAssistantMessageIsCompleteWithApprovalResponses } from "ai"

import type { BizUIMessage } from "../types"
import { ZustandChatState } from "./chat-state"
import type { ChatSlice } from "./types"

// Custom Chat class that uses Zustand-integrated state
export class ZustandChat extends AbstractChat<BizUIMessage> {
  override state: ZustandChatState
  #unsubscribeFns: (() => void)[] = []

  constructor(
    { messages, ...init }: ChatInit<BizUIMessage>,
    updateZustandState: (updater: (state: ChatSlice) => ChatSlice) => void,
  ) {
    const state = new ZustandChatState(messages, updateZustandState, init.id || "")
    super({
      ...init,
      // A tool that needs the user's approval pauses the run; the answer continues by itself once
      // the decision is in the message list, so the panel does not need a second send.
      sendAutomaticallyWhen:
        init.sendAutomaticallyWhen ?? lastAssistantMessageIsCompleteWithApprovalResponses,
      state,
    })
    this.state = state

    const baseResumeStream = this.resumeStream.bind(this)
    // Track resume calls so the state can ignore the temporary "submitted" status when no stream exists.
    this.resumeStream = async (...args) => {
      this.state.setResumingStream(true)
      try {
        return await baseResumeStream(...args)
      } finally {
        this.state.setResumingStream(false)
      }
    }
  }

  // Public getter for state access
  get chatState() {
    return this.state
  }

  /**
   * Replaces the transport of a running chat in place. The AI SDK reads its transport only when a
   * request starts, so swapping it keeps the messages and the stream that is already running, and
   * the next request uses the new endpoint (used when the gateway settings change).
   *
   * NOTE: this pokes the private `transport` field of `AbstractChat` (ai@7.0.109,
   * `src/ui/chat.ts`), so re-check that the field is still assigned once and read per request
   * when `ai` is upgraded; otherwise recreate the chat store instead.
   */
  setTransport(transport: ChatTransport<BizUIMessage>): void {
    const mutableSelf = this as unknown as { transport: ChatTransport<BizUIMessage> }
    mutableSelf.transport = transport
  }

  // Cleanup method
  async destroy(): Promise<void> {
    await this.stop()
    // Unsubscribe from AI SDK callbacks
    this.#unsubscribeFns.forEach((unsubscribe) => unsubscribe())
    this.#unsubscribeFns = []

    this.state.destroy()
  }

  protected override setStatus({ status, error }: { status: ChatStatus; error?: Error }): void {
    super.setStatus({ status, error })
    this.state.status = status
    this.state.error = error
  }
}
