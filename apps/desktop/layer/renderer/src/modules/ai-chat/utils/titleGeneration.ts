import { requestLocalAITitle } from "@follow/store/ai-local/client"
import { isLocalAIEnabled } from "@follow/store/ai-local/config"

import { getActionLanguage } from "~/atoms/settings/general"
import { followClient } from "~/lib/api-client"

import { AIPersistService } from "../services"
import type { SendingUIMessage } from "../store/types"

export const generateChatTitle = async (chatId: string, messages: SendingUIMessage[]) => {
  const relevantMessages = messages.map((msg) => {
    let content = ""
    if (msg.parts && Array.isArray(msg.parts)) {
      for (const part of msg.parts) {
        switch (part.type) {
          case "text": {
            content += `${part.text}`
            break
          }
          case "data-rich-text": {
            content += part.data.text
            break
          }
        }
      }
    }

    return {
      role: msg.role,
      content,
    }
  })

  // Folo's server writes the title upstream; a local gateway has no such route served by Folo, so
  // the same local model writes it instead of failing on an unreachable backend.
  if (isLocalAIEnabled()) {
    return requestLocalAITitle({
      messages: relevantMessages,
      // Titles follow the interface language: a shortcut's own prompt may be written in another one.
      language: getActionLanguage(),
    }).catch((error) => {
      console.error("Failed to generate chat title locally:", error)
      return null
    })
  }

  const response = await followClient.api.ai
    .summaryTitle({
      chatId,
      messages: relevantMessages,
    })
    .catch((error) => {
      console.error("Failed to generate chat title:", error)
      return null
    })

  if (response && "title" in response) {
    return response.title
  }

  return null
}

/**
 * Generate and update chat title based on messages
 * @param chatId - Current chat session ID
 * @param messages - Messages to generate title from
 * @param onTitleUpdate - Callback when title is updated
 * @returns Generated title or null
 */
export const generateAndUpdateChatTitle = async (
  chatId: string,
  messages: SendingUIMessage[],
  onTitleUpdate?: (title: string) => void,
): Promise<string | null> => {
  if (messages.length === 0) {
    return null
  }

  const title = await generateChatTitle(chatId, messages)

  if (title && chatId) {
    try {
      await AIPersistService.updateSessionTitle(chatId, title)
      onTitleUpdate?.(title)
      return title
    } catch (error) {
      console.error("Failed to update session title:", error)
      throw error
    }
  }

  return null
}
