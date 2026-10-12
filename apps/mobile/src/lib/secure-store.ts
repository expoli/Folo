import * as SecureStore from "expo-secure-store"
import Storage from "expo-sqlite/kv-store"

const fallbackPrefix = "follow_secure_store_fallback"
const warnedFallbackKeys = new Set<string>()
let forceFallback = false

/**
 * Thrown when a caller refused the plaintext fallback and the OS keychain is not usable. A caller
 * that keeps a secret must report this instead of storing the secret unencrypted.
 */
export class SecureStorageUnavailableError extends Error {
  constructor() {
    super("The OS keychain is not available, and storing the value unencrypted was refused")
    this.name = "SecureStorageUnavailableError"
  }
}

export interface SecureStoreOptions {
  /**
   * Whether a keychain failure may fall back to the app's own SQLite store. Defaults to `true` for
   * the callers that keep a session token; a secret passes `false` so it is never kept in
   * plaintext.
   */
  allowInsecureFallback?: boolean
}

const getFallbackKey = (key: string) => `${fallbackPrefix}:${key}`

const isSecureStoreUnavailable = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false
  }

  return (
    error.message.includes("KeyChainException") ||
    error.message.includes("required entitlement") ||
    error.message.includes("keychain")
  )
}

const warnFallback = (
  action: "getItem" | "setItem" | "removeItem",
  key: string,
  error: unknown,
) => {
  const warnKey = `${action}:${key}`
  if (warnedFallbackKeys.has(warnKey)) {
    return
  }

  warnedFallbackKeys.add(warnKey)

  if (!(error instanceof Error)) {
    console.warn(`[auth-storage] SecureStore ${action} fallback enabled for ${key}`)
    return
  }

  console.warn(`[auth-storage] SecureStore ${action} fallback enabled for ${key}: ${error.message}`)
}

const getFallbackValue = (key: string) => Storage.getItemSync(getFallbackKey(key))

const deleteSecureStoreItem = async (key: string) => {
  try {
    await SecureStore.deleteItemAsync(key)
  } catch (error) {
    if (isSecureStoreUnavailable(error)) {
      forceFallback = true
      warnFallback("removeItem", key, error)
      return
    }

    console.warn(
      `[auth-storage] SecureStore removeItem failed for ${key}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export const safeSecureStore = {
  getItem(key: string, options: SecureStoreOptions = {}) {
    const allowInsecureFallback = options.allowInsecureFallback ?? true
    if (forceFallback) {
      return allowInsecureFallback ? getFallbackValue(key) : null
    }

    try {
      const value = SecureStore.getItem(key)
      if (value != null) {
        return value
      }
    } catch (error) {
      if (isSecureStoreUnavailable(error)) {
        forceFallback = true
        warnFallback("getItem", key, error)
        return allowInsecureFallback ? getFallbackValue(key) : null
      }

      throw error
    }

    return allowInsecureFallback ? getFallbackValue(key) : null
  },
  setItem(key: string, value: string, options: SecureStoreOptions = {}) {
    const allowInsecureFallback = options.allowInsecureFallback ?? true
    if (forceFallback) {
      if (!allowInsecureFallback) throw new SecureStorageUnavailableError()

      Storage.setItemSync(getFallbackKey(key), value)
      return
    }

    try {
      SecureStore.setItem(key, value)
      // A value that reached the keychain never needs the plaintext copy of an earlier attempt.
      Storage.removeItemSync(getFallbackKey(key))
      return
    } catch (error) {
      if (isSecureStoreUnavailable(error)) {
        forceFallback = true
        warnFallback("setItem", key, error)
        if (!allowInsecureFallback) throw new SecureStorageUnavailableError()

        Storage.setItemSync(getFallbackKey(key), value)
        return
      }

      throw error
    }
  },
  removeItem(key: string) {
    Storage.removeItemSync(getFallbackKey(key))

    if (forceFallback) {
      return
    }

    void deleteSecureStoreItem(key)
  },
  async removeItemAsync(key: string) {
    Storage.removeItemSync(getFallbackKey(key))

    if (forceFallback) {
      return
    }

    await deleteSecureStoreItem(key)
  },
}
