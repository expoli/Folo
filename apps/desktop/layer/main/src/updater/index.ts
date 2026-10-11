import { callWindowExpose } from "@follow/shared/bridge"
import { version as appVersion } from "@pkg"
import { app } from "electron"
import log from "electron-log"
import type { AppUpdater, UpdateInfo } from "electron-updater"
import { autoUpdater as defaultAutoUpdater } from "electron-updater"

import { GITHUB_OWNER, GITHUB_REPO } from "~/constants/app"
import { WindowManager } from "~/manager/window"

import { channel, isWindows } from "../env"
import { appUpdaterConfig } from "./configs"
import { WindowsUpdater } from "./windows-updater"

const logger = log.scope("app-updater")

type UpdateCheckResult = {
  hasUpdate: boolean
  error?: string
}

/** The GitHub provider adds the release tag to the update info it resolves. */
type ProviderUpdateInfo = UpdateInfo & { tag?: string }

/**
 * Whether the running installation can replace itself with a downloaded build.
 *
 * electron-updater swaps an AppImage in place and runs the Windows installer, so those two update
 * themselves. The `.deb` package cannot: packaging writes no `package-type` marker, which makes
 * electron-updater pick the AppImage updater that needs `$APPIMAGE`, and the AppImage is the only
 * Linux artifact in the channel file. The macOS updater (Squirrel.Mac) needs a signed bundle and
 * these builds are unsigned. Both therefore open the release page instead of starting a download
 * that could never be installed.
 */
export const canSelfUpdate = (platform: NodeJS.Platform = process.platform) => {
  switch (platform) {
    case "win32": {
      return true
    }
    case "linux": {
      return Boolean(process.env.APPIMAGE || process.env.APPDIR)
    }
    default: {
      return false
    }
  }
}

/** The release page of the resolved tag, which is where a manual installation starts. */
export const getReleasePageUrl = (version: string, tag?: null | string) =>
  `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/${tag || `v${version}`}`

export class FollowUpdater {
  private readonly disabled: boolean
  private checkingUpdate = false
  private downloadingUpdate = false

  private pollingTimer: NodeJS.Timeout | null = null

  constructor(private readonly autoUpdater: AppUpdater) {
    // Store builds are updated by their store, and a development run has nothing to update.
    this.disabled =
      !appUpdaterConfig.enableAppUpdate || !appUpdaterConfig.enableCoreUpdate || !app.isPackaged
  }

  register() {
    if (this.disabled) {
      logger.info("App auto-update disabled; updater not registered")
      return
    }

    this.autoUpdater.autoDownload = false
    this.autoUpdater.allowPrerelease = channel !== "stable"
    this.autoUpdater.autoInstallOnAppQuit = true
    this.autoUpdater.autoRunAppAfterInstall = true

    // This fork publishes its own builds: the updater reads the newest release of
    // `GITHUB_OWNER`/`GITHUB_REPO` and the `latest*.yml` channel files it ships.
    this.autoUpdater.setFeedURL({
      provider: "github",
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
    })

    this.registerAutoUpdaterEvents()

    if (appUpdaterConfig.app.autoCheckUpdate) {
      logger.info("Initial update check", { version: appVersion })
      void this.checkForUpdates().catch((error) =>
        logger.error("Initial update check failed", error),
      )
    }

    if (this.pollingTimer) {
      clearInterval(this.pollingTimer)
    }

    const updatePollingHandler = async () => {
      if (!appUpdaterConfig.app.autoCheckUpdate) {
        return
      }

      void this.checkForUpdates().catch((error) => {
        logger.error("Scheduled update check failed", error)
      })
    }
    updatePollingHandler()
    this.pollingTimer = setInterval(updatePollingHandler, appUpdaterConfig.app.checkUpdateInterval)
  }

  async checkForUpdates(): Promise<UpdateCheckResult> {
    if (this.disabled) {
      return { hasUpdate: false }
    }

    if (this.checkingUpdate) {
      logger.info("Update check already in progress, skipping")
      return { hasUpdate: false }
    }

    this.checkingUpdate = true

    try {
      const result = await this.autoUpdater.checkForUpdates()

      if (!result?.isUpdateAvailable) {
        logger.info("Update decision: none")
        return { hasUpdate: false }
      }

      const { updateInfo } = result

      if (canSelfUpdate()) {
        // The download was started by the `update-available` handler below and finishes with the
        // `updateDownloaded` notice, which asks the user to restart.
        logger.info("Update decision: self update", { version: updateInfo.version })
        return { hasUpdate: true }
      }

      logger.info("Update decision: manual download", { version: updateInfo.version })
      return await this.notifyManualUpdate(updateInfo)
    } catch (error) {
      logger.error("Failed to check for updates", error)
      return { hasUpdate: false, error: error instanceof Error ? error.message : "Unknown error" }
    } finally {
      this.checkingUpdate = false
    }
  }

  quitAndInstall() {
    const mainWindow = WindowManager.getMainWindow()
    logger.info("Quit and install triggered", { windowId: mainWindow?.id })
    WindowManager.destroyMainWindow()

    setTimeout(() => {
      logger.info("Main window closed, quitting to install update")
      this.autoUpdater.quitAndInstall()
    }, 1000)
  }

  /**
   * Installs this build by hand and therefore gets the release page instead of a download: the
   * renderer shows the same notice it uses for store updates and opens the URL when clicked.
   */
  private async notifyManualUpdate(updateInfo: ProviderUpdateInfo): Promise<UpdateCheckResult> {
    const targetUrl = getReleasePageUrl(updateInfo.version, updateInfo.tag)

    const mainWindow = WindowManager.getMainWindow()
    if (!mainWindow) {
      logger.warn("Main window unavailable when notifying a manual update", { targetUrl })
      return { hasUpdate: true }
    }

    await callWindowExpose(mainWindow).distributionUpdateAvailable({
      distribution: "direct",
      targetUrl,
      storeVersion: updateInfo.version,
      currentVersion: appVersion,
    })

    return { hasUpdate: true }
  }

  private async downloadAppUpdate(): Promise<void> {
    if (this.disabled || this.downloadingUpdate) {
      return
    }

    this.downloadingUpdate = true

    try {
      await this.autoUpdater.downloadUpdate()
      logger.info("App update download requested")
    } catch (error) {
      this.downloadingUpdate = false
      logger.error("Failed to download app update", error)
      throw error
    }
  }

  private registerAutoUpdaterEvents() {
    this.autoUpdater.on("checking-for-update", () => {
      logger.info("autoUpdater: checking for update")
    })

    this.autoUpdater.on("update-available", (info) => {
      logger.info("autoUpdater: update available", info)

      if (
        appUpdaterConfig.app.autoDownloadUpdate &&
        appUpdaterConfig.enableCoreUpdate &&
        canSelfUpdate()
      ) {
        void this.downloadAppUpdate().catch((error) =>
          logger.error("Automatic download failed", error),
        )
      }
    })

    this.autoUpdater.on("update-not-available", (info) => {
      logger.info("autoUpdater: update not available", info)
    })

    this.autoUpdater.on("download-progress", (progress) => {
      logger.info(`autoUpdater: download progress ${progress.percent.toFixed(2)}%`)
    })

    this.autoUpdater.on("update-downloaded", (ev) => {
      this.downloadingUpdate = false
      logger.info("autoUpdater: update downloaded", ev.downloadedFile, ev.version)

      const mainWindow = WindowManager.getMainWindow()
      if (!mainWindow) return

      callWindowExpose(mainWindow).updateDownloaded()
    })

    this.autoUpdater.on("error", (error) => {
      logger.error("autoUpdater: error", error)
    })
  }
}

const autoUpdater = isWindows ? new WindowsUpdater() : defaultAutoUpdater
const followUpdater = new FollowUpdater(autoUpdater)

export const registerUpdater = () => {
  followUpdater.register()
}

export const checkForAppUpdates = () => followUpdater.checkForUpdates()

export const quitAndInstall = () => followUpdater.quitAndInstall()
