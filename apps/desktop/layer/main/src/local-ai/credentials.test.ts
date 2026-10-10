import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

import { join } from "pathe"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  userData: "",
  encryptionAvailable: true,
  // Stands in for the OS keyring: the "ciphertext" never contains the plain key.
  encrypt: vi.fn((value: string) => Buffer.from(`enc:${Buffer.from(value).toString("base64")}`)),
  decrypt: vi.fn((buffer: Buffer) =>
    Buffer.from(buffer.toString("utf8").replace(/^enc:/, ""), "base64").toString("utf8"),
  ),
}))

vi.mock("electron", () => ({
  app: {
    getPath: () => mocks.userData,
  },
  safeStorage: {
    isEncryptionAvailable: () => mocks.encryptionAvailable,
    encryptString: mocks.encrypt,
    decryptString: mocks.decrypt,
  },
}))

const { clearApiKey, hasApiKey, isSecureStorageAvailable, readApiKey, writeApiKey } =
  await import("./credentials")

const keyFilePath = () => join(mocks.userData, "local-ai-api-key")

beforeEach(() => {
  mocks.userData = mkdtempSync(join(tmpdir(), "folo-local-ai-key-"))
  mocks.encryptionAvailable = true
  mocks.encrypt.mockClear()
  mocks.decrypt.mockClear()
})

afterEach(() => {
  rmSync(mocks.userData, { recursive: true, force: true })
})

describe("local AI API key storage", () => {
  test("round-trips a key through the encrypted file", () => {
    expect(isSecureStorageAvailable()).toBe(true)
    expect(hasApiKey()).toBe(false)

    expect(writeApiKey("  secret-key  ")).toEqual({ ok: true, hasApiKey: true })

    expect(hasApiKey()).toBe(true)
    expect(readApiKey()).toBe("secret-key")

    // The key only exists encrypted on disk.
    expect(readFileSync(keyFilePath()).toString("utf8")).not.toContain("secret-key")
    expect(mocks.encrypt).toHaveBeenCalledWith("secret-key")

    clearApiKey()
    expect(hasApiKey()).toBe(false)
    expect(readApiKey()).toBeNull()
  })

  test("refuses to store a key when the system has no keyring", () => {
    mocks.encryptionAvailable = false

    expect(isSecureStorageAvailable()).toBe(false)
    expect(writeApiKey("secret-key")).toEqual({
      ok: false,
      reason: "encryption-unavailable",
      message: expect.stringContaining("keyring"),
    })
    // Nothing was written and nothing is readable, so no plaintext key can be left behind.
    expect(mocks.encrypt).not.toHaveBeenCalled()
    expect(hasApiKey()).toBe(false)
    expect(() => readFileSync(keyFilePath())).toThrow()
  })

  test("rejects an empty key", () => {
    expect(writeApiKey("   ")).toEqual({
      ok: false,
      reason: "empty-key",
      message: expect.any(String),
    })
    expect(mocks.encrypt).not.toHaveBeenCalled()
  })

  test("reports a write failure instead of throwing", () => {
    // A directory where the key file should be makes the write fail on every platform.
    writeFileSync(join(mocks.userData, "blocked"), "")

    const original = mocks.userData
    mocks.userData = join(original, "blocked")

    expect(writeApiKey("secret-key")).toMatchObject({ ok: false, reason: "write-failed" })
  })

  test("reports no key when the stored blob cannot be decrypted", () => {
    mocks.decrypt.mockImplementationOnce(() => {
      throw new Error("cannot decrypt")
    })
    writeFileSync(keyFilePath(), Buffer.from("garbage"))

    expect(readApiKey()).toBeNull()
  })

  test("reports no key for an empty file", () => {
    writeFileSync(keyFilePath(), Buffer.alloc(0))

    expect(hasApiKey()).toBe(false)
  })

  test("clearing an absent key stays quiet", () => {
    expect(() => clearApiKey()).not.toThrow()
    expect(hasApiKey()).toBe(false)
  })
})
