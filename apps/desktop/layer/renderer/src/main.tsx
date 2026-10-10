import "./wdyr"
import "./styles/main.css"
// Registers the "messaging" sync model before the sync engine starts.
import "./lib/web-push-registration"

import { IN_ELECTRON, WEB_BUILD } from "@follow/shared/constants"
import {
  apiContext,
  authClientContext,
  queryClientContext,
  syncApiContext,
} from "@follow/store/context"
import { getOS } from "@follow/utils/utils"
import * as React from "react"
import { flushSync } from "react-dom"
import ReactDOM from "react-dom/client"
import { RouterProvider } from "react-router/dom"

import { authClient } from "~/lib/auth"

import { setAppIsReady } from "./atoms/app"
import { ElECTRON_CUSTOM_TITLEBAR_HEIGHT } from "./constants"
import { initializeApp } from "./initialize"
import { registerAppGlobalShortcuts } from "./initialize/global-shortcuts"
import { followApi } from "./lib/api-client"
import {
  applyLocalAIGatewaySettings,
  subscribeLocalAIGatewaySettings,
} from "./lib/local-ai-gateway"
import { queryClient } from "./lib/query-client"
import { router } from "./router"

authClientContext.provide(authClient)
queryClientContext.provide(queryClient)
apiContext.provide(followApi)
syncApiContext.provide(followApi.sync)

// Route summary / translation / chat through a self-hosted AI gateway when configured. The
// build-time env only supplies the first-run default; Settings → AI changes it at runtime.
applyLocalAIGatewaySettings()
subscribeLocalAIGatewaySettings()

initializeApp().finally(() => {
  import("./push-notification").then(({ registerWebPushNotifications }) => {
    if (navigator.serviceWorker && WEB_BUILD) {
      registerWebPushNotifications()
    }
  })

  flushSync(() => setAppIsReady(true))
})

const $container = document.querySelector("#root") as HTMLElement

if (IN_ELECTRON) {
  const os = getOS()

  switch (os) {
    case "Windows": {
      document.body.style.cssText += `--fo-window-padding-top: ${ElECTRON_CUSTOM_TITLEBAR_HEIGHT}px;`
      break
    }
    case "macOS": {
      document.body.style.cssText += `--fo-macos-traffic-light-width: 80px; --fo-macos-traffic-light-height: 30px;`
      break
    }
  }
  document.documentElement.dataset.os = getOS()
} else {
  registerAppGlobalShortcuts()
}

ReactDOM.createRoot($container).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
)
