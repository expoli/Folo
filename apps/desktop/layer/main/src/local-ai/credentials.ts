import { readFileSync, rmSync, writeFileSync } from "node:fs"

import type { LocalAISetApiKeyResult } from "@follow/shared/settings/local-ai"
import { app, safeStorage } from "electron"
import { join } from "pathe"

/**
 * Encrypted storage of the direct-mode API key.
 *
 * The key never reaches the renderer: it is encrypted with the OS keyring through `safeStorage`
 * and written into the app's own data directory. When no keyring is available the key is *not*
 * stored at all — a plaintext key on disk would be worse than asking the user to type it again.
 */

const KEY_FILE_NAME = "local-ai-api-key"

const keyFilePath = () => join(app.getPath("userData"), KEY_FILE_NAME)

export const isSecureStorageAvailable = () => {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** Decrypts the stored key. Returns `null` when nothing is stored or it cannot be decrypted. */
export const readApiKey = (): string | null => {
  if (!isSecureStorageAvailable()) return null

  try {
    const encrypted = readFileSync(keyFilePath())
    if (encrypted.length === 0) return null

    const key = safeStorage.decryptString(encrypted)
    return key.trim() ? key : null
  } catch {
    // Missing file (never saved, or cleared) and undecryptable blobs both mean "no key".
    return null
  }
}

export const hasApiKey = () => readApiKey() !== null

export const writeApiKey = (key: string): LocalAISetApiKeyResult => {
  const trimmed = key.trim()
  if (!trimmed) {
    return { ok: false, reason: "empty-key", message: "The API key is empty" }
  }

  if (!isSecureStorageAvailable()) {
    return {
      ok: false,
      reason: "encryption-unavailable",
      message:
        "This system provides no keyring, so the app cannot encrypt the key. Set one up (e.g. gnome-keyring or kwallet on Linux) and try again.",
    }
  }

  try {
    // 0600 is honoured on creation, so the encrypted blob is not readable by other users.
    writeFileSync(keyFilePath(), safeStorage.encryptString(trimmed), { mode: 0o600 })
    return { ok: true, hasApiKey: true }
  } catch (error) {
    return {
      ok: false,
      reason: "write-failed",
      message: error instanceof Error ? error.message : "Could not write the key file",
    }
  }
}

export const clearApiKey = () => {
  try {
    rmSync(keyFilePath(), { force: true })
  } catch (error) {
    console.error("[local-ai] could not remove the stored key:", error)
  }
}
