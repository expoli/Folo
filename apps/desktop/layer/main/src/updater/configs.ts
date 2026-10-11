import { MICROSOFT_STORE_BUILD } from "@follow/shared/constants"

const isStoreDistribution = Boolean(process.mas || MICROSOFT_STORE_BUILD)

export const appUpdaterConfig = {
  // The renderer is part of the build: this fork publishes whole builds to its own GitHub
  // releases, so there is no OTA bundle to hot swap (see `.github/workflows/release-desktop.yml`).
  enableRenderHotUpdate: false,
  // Store builds are updated by their store instead of by electron-updater
  enableCoreUpdate: !isStoreDistribution,

  // Disable app update will also disable renderer hot update and core update
  enableAppUpdate: true,

  app: {
    autoCheckUpdate: true,
    autoDownloadUpdate: true,
    checkUpdateInterval: 15 * 60 * 1000,
  },
}
