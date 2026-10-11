import { existsSync, readFileSync } from "node:fs"
import { readdir, rm, stat } from "node:fs/promises"

import { runtimeVersion as configuredRuntimeVersion, version as appVersion } from "@pkg"
import log from "electron-log"
import { load } from "js-yaml"
import path from "pathe"
import { compare } from "semver"

import { HOTUPDATE_RENDER_ENTRY_DIR } from "~/constants/app"

import { appUpdaterConfig } from "./configs"

export type RendererManifest = {
  runtimeVersion: string
  version: string
  releaseVersion: string
  commit: string
  downloadUrl: string
  hash: string
  filename: string
  downloadedAt?: string
}

const getCurrentRendererContext = () => ({
  appVersion,
  runtimeVersion: configuredRuntimeVersion ?? appVersion,
})

const normalizeRendererVersion = (version?: null | string) => {
  const normalized = version?.split("-")[0]?.trim()
  if (!normalized) {
    return null
  }

  return /^\d+\.\d+\.\d+$/.test(normalized) ? normalized : null
}

const compareRendererVersions = (left?: null | string, right?: null | string) => {
  const normalizedLeft = normalizeRendererVersion(left)
  const normalizedRight = normalizeRendererVersion(right)

  if (!normalizedLeft || !normalizedRight) {
    return null
  }

  return compare(normalizedLeft, normalizedRight)
}

export const isRendererManifestUsable = (
  manifest: null | Partial<Pick<RendererManifest, "runtimeVersion" | "version">>,
  input: { appVersion: string; runtimeVersion: string },
) => {
  if (!manifest?.runtimeVersion || manifest.runtimeVersion !== input.runtimeVersion) {
    return false
  }

  const versionComparison = compareRendererVersions(manifest.version, input.appVersion)
  if (versionComparison === null) {
    return false
  }

  return versionComparison >= 0
}

class RendererHotUpdater {
  private readonly logger = log.scope("updater:renderer")
  private readonly manifestPath = path.resolve(HOTUPDATE_RENDER_ENTRY_DIR, "manifest.yml")

  getCurrentManifest(): RendererManifest | null {
    if (!existsSync(this.manifestPath)) {
      return null
    }

    try {
      const content = readFileSync(this.manifestPath, "utf-8")
      const parsed = load(content)
      if (parsed && typeof parsed === "object") {
        return parsed as RendererManifest
      }
    } catch (error) {
      this.logger.warn("Failed to read renderer manifest from disk", error)
    }

    return null
  }

  async cleanup(): Promise<void> {
    const manifest = this.getCurrentManifest()
    if (!manifest || !isRendererManifestUsable(manifest, getCurrentRendererContext())) {
      await rm(HOTUPDATE_RENDER_ENTRY_DIR, { recursive: true, force: true })
      return
    }

    const keepDir = path.resolve(HOTUPDATE_RENDER_ENTRY_DIR, manifest.version)
    let entries: string[] = []

    try {
      entries = await readdir(HOTUPDATE_RENDER_ENTRY_DIR)
    } catch (error) {
      this.logger.warn("Failed to read renderer directory for cleanup", error)
      return
    }

    await Promise.all(
      entries.map(async (entryName) => {
        const entryPath = path.resolve(HOTUPDATE_RENDER_ENTRY_DIR, entryName)
        const entryStat = await stat(entryPath).catch(() => null)
        if (!entryStat?.isDirectory()) return
        if (entryPath === keepDir) return
        await rm(entryPath, { recursive: true, force: true })
      }),
    )
  }

  /**
   * A renderer bundle left behind by an older Folo build, which is why this is only read while
   * renderer hot updates are enabled.
   */
  loadDynamicEntry() {
    if (!appUpdaterConfig.enableRenderHotUpdate) return

    const manifest = this.getCurrentManifest()
    if (!manifest) return
    if (!isRendererManifestUsable(manifest, getCurrentRendererContext())) {
      return
    }

    const dir = path.resolve(HOTUPDATE_RENDER_ENTRY_DIR, manifest.version)
    const entryFile = path.resolve(dir, "index.html")
    if (!existsSync(entryFile)) return

    return entryFile
  }
}

const rendererUpdater = new RendererHotUpdater()

export const cleanupOldRenderer = async () => {
  await rendererUpdater.cleanup()
}

export const cleanupOldRender = cleanupOldRenderer

export const getCurrentRendererManifest = () => rendererUpdater.getCurrentManifest()

export const loadDynamicRenderEntry = () => rendererUpdater.loadDynamicEntry()
