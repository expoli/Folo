/**
 * Settings surface of the local agent reading endpoint.
 *
 * Only the trusted main window reaches these methods: the token is revealed here, so any other
 * renderer — a webview, a devtools-driven window, a second instance — must not be able to ask for
 * it. The endpoint itself is guarded separately in `local-agent-reading/server.ts`.
 */
import type {
  LocalAgentReadingSettingsStatus,
  LocalAgentReadingTokenReveal,
} from "@follow/shared/local-agent-reading"
import { getIpcContext, IpcMethod, IpcService } from "electron-ipc-decorator"

import { localAgentReadingService } from "../../local-agent-reading"
import { WindowManager } from "../../manager/window"

interface SetEnabledInput {
  enabled: boolean
}

const ensureTrustedSender = () => {
  const mainWindow = WindowManager.getMainWindow()
  const { sender } = getIpcContext()
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents !== sender) {
    throw new Error("The local agent reading settings are only available to Folo's main window")
  }
}

export class LocalAgentReadingIpcService extends IpcService {
  static override readonly groupName = "localAgentReading"

  /** Switch state, endpoint, and whether the token lives in the OS keyring or only this session. */
  @IpcMethod()
  getStatus(): LocalAgentReadingSettingsStatus {
    ensureTrustedSender()
    return localAgentReadingService.settingsStatus()
  }

  /** Turning it off revokes the token and drops every scan; turning it on mints one if needed. */
  @IpcMethod()
  async setEnabled(input: SetEnabledInput): Promise<LocalAgentReadingSettingsStatus> {
    ensureTrustedSender()
    return localAgentReadingService.setEnabled(input.enabled)
  }

  /**
   * Allows or forbids article page fetching (`source_page` mode). Turning it off aborts the page
   * reads that are still running; it is a separate choice from the endpoint switch.
   */
  @IpcMethod()
  setSourcePageEnabled(input: SetEnabledInput): LocalAgentReadingSettingsStatus {
    ensureTrustedSender()
    return localAgentReadingService.setSourcePageEnabled(input.enabled)
  }

  /** Shows the dedicated token, for the user to copy into an agent's configuration. */
  @IpcMethod()
  revealToken(): LocalAgentReadingTokenReveal {
    ensureTrustedSender()
    return localAgentReadingService.revealToken()
  }

  /** Replaces the token; the previous one stops working and running scans are dropped. */
  @IpcMethod()
  rotateToken(): LocalAgentReadingTokenReveal {
    ensureTrustedSender()
    return localAgentReadingService.rotateToken()
  }

  /** Drops the token without turning the switch off: every request is refused afterwards. */
  @IpcMethod()
  revokeToken(): LocalAgentReadingTokenReveal {
    ensureTrustedSender()
    return localAgentReadingService.revokeToken()
  }
}
