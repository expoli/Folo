/**
 * Wiring of the local agent reading service into the desktop app.
 *
 * The service itself takes its data source and its account resolver as arguments (see `service.ts`)
 * so it can be tested without Electron. This module is the one place that binds it to the running
 * app: the main window answers data calls, the session API answers "who is signed in", and the
 * electron-store flag holds the user's on/off choice.
 */
import { app } from "electron"

import { logger } from "~/logger"
import { WindowManager } from "~/manager/window"

import { store } from "../lib/store"
import { resolveSessionAccount } from "./account"
import { createRendererDataProvider } from "./provider"
import { LocalAgentReadingService } from "./service"

const SETTINGS_KEY = "localAgentReadingEnabled"

/**
 * Permission for reads that leave the account API (`source_page`). It is separate from the
 * endpoint switch, and absent means off: an older profile must not start fetching article pages.
 */
const SOURCE_PAGE_SETTINGS_KEY = "localAgentReadingSourcePageEnabled"

export const localAgentReadingService = new LocalAgentReadingService({
  provider: createRendererDataProvider({
    getWindow: () => WindowManager.getMainWindow(),
    log: (line) => logger.info(line),
  }),
  resolveAccount: resolveSessionAccount,
  isEnabled: () => store.get(SETTINGS_KEY) === true,
  setEnabledFlag: (enabled) => {
    store.set(SETTINGS_KEY, enabled)
  },
  isSourcePageEnabled: () => store.get(SOURCE_PAGE_SETTINGS_KEY) === true,
  setSourcePageEnabledFlag: (enabled) => {
    store.set(SOURCE_PAGE_SETTINGS_KEY, enabled)
  },
  log: (line) => logger.info(line),
})

/**
 * Starts the endpoint when the user left it on, and closes the socket when the app quits.
 *
 * A failure here must never keep the app from starting: the endpoint is an optional feature.
 */
export const startLocalAgentReading = async (): Promise<void> => {
  app.on("before-quit", () => {
    void localAgentReadingService.stop()
  })

  await localAgentReadingService.start()
}
