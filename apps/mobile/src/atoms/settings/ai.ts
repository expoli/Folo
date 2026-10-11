import { defaultAISettings } from "@follow/shared/settings/defaults"
import type { AISettings, LocalAIGatewaySettings } from "@follow/shared/settings/interface"

import { createSettingAtom } from "./internal/helper"

/**
 * AI settings on this device. Desktop seeds the gateway fields from `VITE_LOCAL_AI_GATEWAY_URL`;
 * mobile seeds the same fields from `EXPO_PUBLIC_LOCAL_AI_GATEWAY_URL`, which is how a build used
 * to point at a gateway before the in-app screen existed. Settings → AI overrides both at runtime.
 */
export const createDefaultAISettings = (): AISettings => ({
  ...defaultAISettings,
  localGateway: {
    ...defaultAISettings.localGateway,
    enabled: Boolean(process.env.EXPO_PUBLIC_LOCAL_AI_GATEWAY_URL),
    baseUrl: process.env.EXPO_PUBLIC_LOCAL_AI_GATEWAY_URL ?? "",
    token: process.env.EXPO_PUBLIC_LOCAL_AI_TOKEN ?? "",
  },
})

export const {
  useSettingKey: useAISettingKey,
  useSettingSelector: useAISettingSelector,
  useSettingValue: useAISettingValue,
  setSetting: setAISetting,
  getSettings: getAISettings,
  clearSettings: clearAISettings,
  initializeDefaultSettings: initializeDefaultAISettings,
  settingAtom: __aiSettingAtom,
} = createSettingAtom("ai", createDefaultAISettings)

/** Writes part of the local-AI settings and keeps the fields that are not part of the patch. */
export const setLocalAIGatewaySetting = (patch: Partial<LocalAIGatewaySettings>) => {
  setAISetting("localGateway", { ...getAISettings().localGateway, ...patch })
}
