import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { setDeepLinkHandler, setRendererReady } from "../../lib/deep-link"
import { AuthService } from "./auth"

const mocks = vi.hoisted(() => ({
  app: { isPackaged: false },
  openExternal: vi.fn(async (_url: string) => {}),
  mainWindow: { isDestroyed: () => false, isMinimized: () => false },
}))

vi.mock("electron", () => ({
  app: mocks.app,
  net: { fetch: globalThis.fetch },
  shell: { openExternal: mocks.openExternal },
}))
vi.mock("electron-ipc-decorator", () => ({
  IpcMethod: () => (_target: unknown, _key: string, descriptor: PropertyDescriptor) => descriptor,
  IpcService: class {},
}))
vi.mock("@follow/shared/constants", () => ({ APP_PROTOCOL: "folo", LEGACY_APP_PROTOCOL: "follow" }))
vi.mock("~/constants/app", () => ({
  BETTER_AUTH_COOKIE_NAME_SESSION_TOKEN: "better-auth.session_token",
}))
vi.mock("@follow/shared/env.desktop", () => ({
  env: { VITE_WEB_URL: "https://app.folo.is", VITE_API_URL: "https://api.folo.is" },
}))
vi.mock("../../manager/window", () => ({
  WindowManager: { getMainWindow: () => mocks.mainWindow, showMainWindow: vi.fn() },
}))
vi.mock("../../lib/cli-session-sync", () => ({
  getCliSessionToken: vi.fn(),
  isCliSyncEnabled: () => false,
  syncSessionToCliConfig: vi.fn(),
}))
vi.mock("../../lib/user", () => ({
  deleteNotificationsToken: vi.fn(),
  updateNotificationsToken: vi.fn(),
}))
vi.mock("../../logger", () => ({ logger: { error: vi.fn() } }))

const received: string[] = []

const callbackFromBrowser = (callIndex: number) => {
  const loginURL = new URL(mocks.openExternal.mock.calls[callIndex]![0])
  return new URL(loginURL.searchParams.get("cli_callback")!)
}

beforeEach(() => {
  mocks.app.isPackaged = false
  mocks.openExternal.mockReset().mockResolvedValue(undefined)
  received.length = 0
  setDeepLinkHandler((url) => received.push(url))
  setRendererReady(true)
})

afterEach(async () => {
  for (const [url] of mocks.openExternal.mock.calls) {
    const callback = new URL(url).searchParams.get("cli_callback")
    if (!callback) continue
    const cleanupURL = new URL(callback)
    cleanupURL.searchParams.set("token", "cleanup-token")
    await fetch(cleanupURL).catch(() => {})
  }
  setRendererReady(false)
})

describe("browser login routing", () => {
  test("delivers the browser callback to this instance's deep-link handler", async () => {
    const service = new AuthService()
    await service.openBrowserLogin("github")
    const loginURL = new URL(mocks.openExternal.mock.calls[0]![0])
    const callback = callbackFromBrowser(0)
    expect(loginURL.origin).toBe("https://app.folo.is")
    expect(loginURL.searchParams.get("provider")).toBe("github")
    expect(callback.hostname).toBe("127.0.0.1")

    callback.searchParams.set("token", "one-time-browser-token")
    expect((await fetch(callback)).status).toBe(200)
    expect(received).toHaveLength(1)
    expect(new URL(received[0]!).hostname).toBe("auth")
    expect(new URL(received[0]!).searchParams.get("token")).toBe("one-time-browser-token")
    expect(mocks.openExternal).toHaveBeenCalledTimes(1)
  })

  test("invalidates an earlier attempt when another provider login begins", async () => {
    const service = new AuthService()
    await service.openBrowserLogin("github")
    const previous = callbackFromBrowser(0)
    await service.openBrowserLogin("google")
    const current = callbackFromBrowser(1)
    previous.searchParams.set("token", "stale-token")
    current.searchParams.set("token", "current-token")

    await expect(fetch(previous)).rejects.toThrow()
    expect((await fetch(current)).status).toBe(200)
    expect(received.map((url) => new URL(url).searchParams.get("token"))).toEqual(["current-token"])
  })

  test("closes the callback listener when the system browser cannot open", async () => {
    mocks.openExternal.mockRejectedValueOnce(new Error("No browser available"))
    await expect(new AuthService().openBrowserLogin("github")).rejects.toThrow(
      "No browser available",
    )
    const callback = callbackFromBrowser(0)
    callback.searchParams.set("token", "unused-token")
    await expect(fetch(callback)).rejects.toThrow()
    expect(received).toEqual([])
  })

  test("keeps packaged app login on its normal protocol flow", async () => {
    mocks.app.isPackaged = true
    await new AuthService().openBrowserLogin("apple")
    const url = new URL(mocks.openExternal.mock.calls[0]![0])
    expect(url.searchParams.get("provider")).toBe("apple")
    expect(url.searchParams.has("cli_callback")).toBe(false)
    expect(received).toEqual([])
  })
})
