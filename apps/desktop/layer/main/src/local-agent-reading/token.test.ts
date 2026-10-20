import { mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"

import { join } from "pathe"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  userData: "",
  encryptionAvailable: true,
}))

vi.mock("electron", () => ({
  app: { getPath: () => mocks.userData },
  safeStorage: {
    isEncryptionAvailable: () => mocks.encryptionAvailable,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, "utf8"),
    decryptString: (buffer: Buffer) => buffer.toString("utf8").replace(/^enc:/, ""),
  },
}))

const {
  LOCAL_AGENT_READING_TOKEN_PREFIX,
  createToken,
  issueToken,
  matchesCurrentToken,
  readToken,
  resetTokenCache,
  revokeToken,
  tokensMatch,
} = await import("./token")

beforeEach(() => {
  mocks.userData = mkdtempSync(join(tmpdir(), "folo-local-agent-reading-token-"))
  mocks.encryptionAvailable = true
  resetTokenCache()
})

afterEach(() => {
  resetTokenCache()
})

describe("token creation", () => {
  test("mints a prefixed, long, unique secret", () => {
    const first = createToken()
    const second = createToken()

    expect(first.startsWith(LOCAL_AGENT_READING_TOKEN_PREFIX)).toBe(true)
    // 32 random bytes in base64url are 43 characters; the prefix must not shorten the secret.
    expect(first.length).toBeGreaterThanOrEqual(LOCAL_AGENT_READING_TOKEN_PREFIX.length + 43)
    expect(first).not.toBe(second)
  })

  test("compares only whole tokens", () => {
    const token = createToken()

    expect(tokensMatch(token, token)).toBe(true)
    expect(tokensMatch(token, token.slice(0, -1))).toBe(false)
    expect(tokensMatch(token, `${token}x`)).toBe(false)
    // A token that shares the prefix is still a different token.
    expect(tokensMatch(token, token.slice(0, 12))).toBe(false)
  })
})

describe("token storage", () => {
  test("stores the token with the OS keyring and reads it back", () => {
    const issued = issueToken()
    expect(issued.ok).toBe(true)
    if (!issued.ok) return

    expect(issued.state.persistence).toBe("os-keyring")
    expect(readToken()).toEqual({ token: issued.state.token, persistence: "os-keyring" })
    // The secret is only on disk encrypted, never as a readable file name or plaintext file.
    expect(readdirSync(mocks.userData)).toEqual(["local-agent-reading-token"])
    expect(matchesCurrentToken(issued.state.token!)).toBe(true)
  })

  test("keeps the token in memory only when the keyring is unavailable", () => {
    mocks.encryptionAvailable = false

    const issued = issueToken()
    expect(issued.ok).toBe(true)
    if (!issued.ok) return

    expect(issued.state.persistence).toBe("memory")
    expect(readToken()).toEqual({ token: issued.state.token, persistence: "memory" })
    // Nothing was written: a plaintext secret would be worse than losing it on restart.
    expect(readdirSync(mocks.userData)).toEqual([])
  })

  test("revoking drops the secret for this and the next session", () => {
    const issued = issueToken()
    expect(issued.ok).toBe(true)
    if (!issued.ok) return

    revokeToken()

    expect(readToken().token).toBeNull()
    expect(matchesCurrentToken(issued.state.token!)).toBe(false)
    expect(readdirSync(mocks.userData)).toEqual([])
  })

  test("a rotated token stops matching the previous one", () => {
    const first = issueToken()
    expect(first.ok).toBe(true)
    if (!first.ok) return

    revokeToken()
    const second = issueToken()
    expect(second.ok).toBe(true)
    if (!second.ok) return

    expect(matchesCurrentToken(first.state.token!)).toBe(false)
    expect(matchesCurrentToken(second.state.token!)).toBe(true)
    expect(second.state.token).not.toBe(first.state.token)
  })

  test("an undecryptable file reads as no token instead of throwing", () => {
    const issued = issueToken()
    expect(issued.ok).toBe(true)
    resetTokenCache()

    // Simulate a token file from another machine / a rotated keyring.
    const { writeFileSync } = require("node:fs") as typeof import("node:fs")
    writeFileSync(join(mocks.userData, "local-agent-reading-token"), Buffer.alloc(0))

    expect(readToken().token).toBeNull()
  })
})
