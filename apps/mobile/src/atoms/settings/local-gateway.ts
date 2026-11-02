import type { LocalAIGatewaySettings } from "@follow/shared/settings/interface"
import { normalizeLocalAIBaseUrl } from "@follow/store/ai-local/config"

/**
 * The next `localGateway` value for a patch.
 *
 * On mobile the settings screen only configures a direct endpoint, while `mode` decides which
 * address the runtime reads. A patch that touches a direct field selects that mode only when
 * the merged settings contain a usable direct endpoint. An explicit `mode` still wins, and a
 * patch that only flips the switch keeps whichever mode was configured.
 */
export const applyLocalGatewayPatch = (
  current: LocalAIGatewaySettings,
  patch: Partial<LocalAIGatewaySettings>,
): LocalAIGatewaySettings => {
  const configuresDirect =
    "directBaseUrl" in patch ||
    "directModel" in patch ||
    "directModels" in patch ||
    "directOptions" in patch
  const next = { ...current, ...patch }

  return {
    ...next,
    mode:
      patch.mode ??
      (configuresDirect && normalizeLocalAIBaseUrl(next.directBaseUrl) ? "direct" : current.mode),
  }
}
