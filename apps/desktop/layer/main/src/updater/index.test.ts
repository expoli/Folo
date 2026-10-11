import type { AppUpdater } from "electron-updater"
import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  distributionUpdateAvailable: vi.fn(),
  updateDownloaded: vi.fn(),
  mainWindow: { id: 1 },
}))

vi.mock("@follow/shared/bridge", () => ({
  callWindowExpose: () => ({
    distributionUpdateAvailable: mocks.distributionUpdateAvailable,
    updateDownloaded: mocks.updateDownloaded,
  }),
}))

vi.mock("@pkg", () => ({
  version: "1.15.0",
}))

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getPath: () => "/tmp",
  },
}))

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}))

vi.mock("electron-updater", () => ({
  autoUpdater: {
    setFeedURL: vi.fn(),
    on: vi.fn(),
  },
}))

vi.mock("../env", () => ({
  channel: "stable",
  isWindows: false,
}))

vi.mock("./configs", () => ({
  appUpdaterConfig: {
    enableRenderHotUpdate: false,
    enableCoreUpdate: true,
    enableAppUpdate: true,
    app: {
      autoCheckUpdate: false,
      autoDownloadUpdate: true,
      checkUpdateInterval: 900_000,
    },
  },
}))

vi.mock("./windows-updater", () => ({
  WindowsUpdater: class {},
}))

vi.mock("~/manager/window", () => ({
  WindowManager: {
    getMainWindow: () => mocks.mainWindow,
    destroyMainWindow: vi.fn(),
  },
}))

const { FollowUpdater, canSelfUpdate, getReleasePageUrl } = await import("./index")

const createUpdater = (input: { isUpdateAvailable: boolean; tag?: string }) => {
  const updateInfo = { version: "1.16.0", ...(input.tag ? { tag: input.tag } : {}) }
  const autoUpdater = {
    checkForUpdates: vi.fn(async () => ({
      isUpdateAvailable: input.isUpdateAvailable,
      updateInfo,
    })),
  }

  return {
    updater: new FollowUpdater(autoUpdater as unknown as AppUpdater),
    updateInfo,
  }
}

const clearAppImageEnv = () => {
  delete process.env.APPIMAGE
  delete process.env.APPDIR
}

describe("canSelfUpdate", () => {
  afterEach(clearAppImageEnv)

  it("lets the Windows installer and the AppImage replace themselves", () => {
    expect(canSelfUpdate("win32")).toBe(true)

    process.env.APPIMAGE = "/opt/Folo.AppImage"
    expect(canSelfUpdate("linux")).toBe(true)
  })

  it("sends installations that cannot replace themselves to the release page", () => {
    clearAppImageEnv()
    expect(canSelfUpdate("linux")).toBe(false)
    expect(canSelfUpdate("darwin")).toBe(false)
  })
})

describe("getReleasePageUrl", () => {
  it("prefers the tag electron-updater resolved", () => {
    expect(getReleasePageUrl("1.16.0", "v1.16.0")).toBe(
      "https://github.com/expoli/Folo/releases/tag/v1.16.0",
    )
  })

  it("falls back to the version when the provider reports no tag", () => {
    expect(getReleasePageUrl("1.16.0")).toBe("https://github.com/expoli/Folo/releases/tag/v1.16.0")
  })
})

describe("update decision", () => {
  afterEach(() => {
    vi.clearAllMocks()
    clearAppImageEnv()
  })

  it("reports nothing to do when the release is not newer", async () => {
    const { updater } = createUpdater({ isUpdateAvailable: false })

    await expect(updater.checkForUpdates()).resolves.toEqual({ hasUpdate: false })
    expect(mocks.distributionUpdateAvailable).not.toHaveBeenCalled()
  })

  it("lets electron-updater install the update inside an AppImage", async () => {
    process.env.APPIMAGE = "/opt/Folo.AppImage"
    const { updater } = createUpdater({ isUpdateAvailable: true, tag: "v1.16.0" })

    await expect(updater.checkForUpdates()).resolves.toEqual({ hasUpdate: true })
    expect(mocks.distributionUpdateAvailable).not.toHaveBeenCalled()
  })

  it("points every other installation at the release page", async () => {
    const { updater } = createUpdater({ isUpdateAvailable: true, tag: "v1.16.0" })

    await expect(updater.checkForUpdates()).resolves.toEqual({ hasUpdate: true })
    expect(mocks.distributionUpdateAvailable).toHaveBeenCalledWith({
      distribution: "direct",
      targetUrl: "https://github.com/expoli/Folo/releases/tag/v1.16.0",
      storeVersion: "1.16.0",
      currentVersion: "1.15.0",
    })
  })
})
