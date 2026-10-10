import type { LocalAIGatewaySettings } from "@follow/shared/settings/interface"
import type { LocalAIConfig } from "@follow/store/ai-local/config"
import {
  configureLocalAI,
  getLocalAIConfig,
  resolveLocalAIConfig,
} from "@follow/store/ai-local/config"
import { EventBus } from "@follow/utils/event-bus"
import { jotaiStore } from "@follow/utils/jotai"
import { isEqual } from "es-toolkit"
import { atom, useAtomValue } from "jotai"

import { createDefaultSettings, getAISettings } from "~/atoms/settings/ai"
import { queryClient } from "~/lib/query-client"
import { ChatSliceActions } from "~/modules/ai-chat/store/chat-core/chat-actions"

/**
 * Runtime wiring of the self-hosted AI gateway.
 *
 * The address and the token live in the `ai` settings, so a packaged app can be pointed at
 * another gateway from Settings → AI without a rebuild. `VITE_LOCAL_AI_GATEWAY_URL` /
 * `VITE_LOCAL_AI_TOKEN` only seed the first run, see `createDefaultSettings`.
 */

/** Last config handed to `configureLocalAI`, so React consumers re-render on a change. */
const effectiveLocalAIConfigAtom = atom<LocalAIConfig>(getLocalAIConfig())
const atomOptions = { store: jotaiStore }

export const useLocalAIConfig = () => useAtomValue(effectiveLocalAIConfigAtom, atomOptions)

/** Saved gateway settings; settings stored before the gateway existed fall back to the defaults. */
export const getLocalGatewaySettings = (): LocalAIGatewaySettings =>
  getAISettings().localGateway ?? createDefaultSettings().localGateway

/**
 * Pushes the saved settings into the shared store, so summary / translation / chat pick the new
 * gateway up on their next request. Called at bootstrap and whenever the settings change.
 */
export const applyLocalAIGatewaySettings = (): LocalAIConfig => {
  const config = configureLocalAI(resolveLocalAIConfig(getLocalGatewaySettings()))
  jotaiStore.set(effectiveLocalAIConfigAtom, config)

  return config
}

/**
 * Applies a gateway saved in Settings → AI while the app runs: the model catalogue is reloaded
 * (it belongs to the gateway) and every mounted chat rebuilds its transport. Returns the
 * unsubscribe function of the settings listener.
 */
export const subscribeLocalAIGatewaySettings = () =>
  EventBus.subscribe("SETTING_CHANGE_EVENT", ({ key, payload }) => {
    if (key !== "ai" || !("localGateway" in payload)) return

    const previous = getLocalAIConfig()
    const next = applyLocalAIGatewaySettings()
    if (isEqual(previous, next)) return

    void queryClient.invalidateQueries({ queryKey: ["aiConfiguration"] })
    ChatSliceActions.recreateTransportEverywhere()
  })
