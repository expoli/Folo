import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * The keychain wrapper of the app. Its default is the plaintext application store (a session token
 * has to survive a missing keychain), but a caller that keeps a secret can refuse that fallback —
 * which is what the Local AI API key does.
 */
const mocks = vi.hoisted(() => ({
  keychain: new Map<string, string>(),
  storage: new Map<string, string>(),
  getError: null as Error | null,
  setError: null as Error | null,
}))

vi.mock("expo-secure-store", () => ({
  getItem: (key: string) => {
    if (mocks.getError) throw mocks.getError
    return mocks.keychain.get(key) ?? null
  },
  setItem: (key: string, value: string) => {
    if (mocks.setError) throw mocks.setError
    mocks.keychain.set(key, value)
  },
  deleteItemAsync: async (key: string) => {
    mocks.keychain.delete(key)
  },
}))

vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItemSync: (key: string) => mocks.storage.get(key) ?? null,
    setItemSync: (key: string, value: string) => {
      mocks.storage.set(key, value)
    },
    removeItemSync: (key: string) => {
      mocks.storage.delete(key)
    },
  },
}))

const keychainDown = () => new Error("KeyChainException: the keychain is not available")

/** A fresh module per case: the wrapper remembers that the keychain failed. */
const load = async () => {
  vi.resetModules()
  return import("./secure-store")
}

beforeEach(() => {
  mocks.keychain.clear()
  mocks.storage.clear()
  mocks.getError = null
  mocks.setError = null
})

describe("safeSecureStore", () => {
  test("keeps using the application store for callers that did not refuse the fallback", async () => {
    const { safeSecureStore } = await load()

    mocks.getError = keychainDown()
    expect(safeSecureStore.getItem("auth-token")).toBeNull()

    safeSecureStore.setItem("auth-token", "token")
    expect(mocks.storage.get("follow_secure_store_fallback:auth-token")).toBe("token")
  })

  test("never reads the plaintext copy when the fallback is refused", async () => {
    mocks.storage.set("follow_secure_store_fallback:follow_local_ai_direct_api_key", "sk-plaintext")
    mocks.getError = keychainDown()

    const { safeSecureStore } = await load()

    // The key was written unencrypted by an earlier build; it must not be used any more.
    expect(
      safeSecureStore.getItem("follow_local_ai_direct_api_key", { allowInsecureFallback: false }),
    ).toBeNull()
  })

  test("never writes the plaintext copy when the fallback is refused", async () => {
    mocks.setError = keychainDown()
    const { safeSecureStore, SecureStorageUnavailableError } = await load()

    expect(() =>
      safeSecureStore.setItem("follow_local_ai_direct_api_key", "sk-secret", {
        allowInsecureFallback: false,
      }),
    ).toThrow(SecureStorageUnavailableError)
    expect(mocks.storage.size).toBe(0)
  })

  test("still reads and writes through the keychain when it works", async () => {
    const { safeSecureStore } = await load()

    safeSecureStore.setItem("follow_local_ai_direct_api_key", "sk-keychain", {
      allowInsecureFallback: false,
    })

    expect(mocks.keychain.get("follow_local_ai_direct_api_key")).toBe("sk-keychain")
    expect(
      safeSecureStore.getItem("follow_local_ai_direct_api_key", { allowInsecureFallback: false }),
    ).toBe("sk-keychain")
  })

  test("removes a leftover plaintext copy of a secret", async () => {
    mocks.storage.set("follow_secure_store_fallback:follow_local_ai_direct_api_key", "sk-plaintext")
    const { safeSecureStore } = await load()

    safeSecureStore.removeItem("follow_local_ai_direct_api_key")

    expect(mocks.storage.has("follow_secure_store_fallback:follow_local_ai_direct_api_key")).toBe(
      false,
    )
  })
})
