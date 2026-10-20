/**
 * Dedicated access token of the local agent reading endpoint.
 *
 * The token is what separates "an agent the user configured" from "any process on the machine that
 * guessed the port", so it is generated with a CSPRNG, compared in constant time, and stored
 * encrypted with the OS keyring. When no keyring is available the token is kept in memory for this
 * session only: a plaintext secret on disk would be worse than asking the user to mint a new one
 * after a restart. That mode is reported, never hidden.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { readFileSync, rmSync, writeFileSync } from "node:fs"

import type { LocalAgentReadingTokenPersistence } from "@follow/shared/local-agent-reading"
import { app, safeStorage } from "electron"
import { join } from "pathe"

const TOKEN_FILE_NAME = "local-agent-reading-token"
/** 256 bits of entropy, spelled out so the length requirement is not a magic number. */
const TOKEN_BYTES = 32
/** Lets the user and the log tell this secret apart from the model API key. */
export const LOCAL_AGENT_READING_TOKEN_PREFIX = "folo_lar_"

/** Token of this session when the OS keyring is unavailable. */
let sessionToken: string | null = null
/** Last token handed out, so a request does not decrypt the file every time. */
let cachedToken: string | null = null
let cachedPersistence: LocalAgentReadingTokenPersistence | null = null

export interface LocalAgentReadingTokenState {
  token: string | null
  persistence: LocalAgentReadingTokenPersistence
}

const tokenFilePath = () => join(app.getPath("userData"), TOKEN_FILE_NAME)

export const isSecureStorageAvailable = (): boolean => {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export const createToken = (): string =>
  `${LOCAL_AGENT_READING_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`

/** Hash comparison: equal only when the whole token matches, without an early exit. */
export const tokensMatch = (expected: string, candidate: string): boolean => {
  const left = createHash("sha256").update(expected).digest()
  const right = createHash("sha256").update(candidate).digest()
  return timingSafeEqual(left, right)
}

const readTokenFile = (): string | null => {
  try {
    const encrypted = readFileSync(tokenFilePath())
    if (encrypted.length === 0) return null
    const token = safeStorage.decryptString(encrypted).trim()
    return token || null
  } catch {
    // Never stored, removed, or undecryptable on another machine: all mean "no token".
    return null
  }
}

/** Current token and where it lives. `null` means nothing is issued right now. */
export const readToken = (): LocalAgentReadingTokenState => {
  const persistence: LocalAgentReadingTokenPersistence = isSecureStorageAvailable()
    ? "os-keyring"
    : "memory"

  if (persistence === "memory") {
    // A keyring that disappeared must not resurrect a token still cached from a previous read.
    cachedToken = sessionToken
    cachedPersistence = persistence
    return { token: sessionToken, persistence }
  }

  if (cachedPersistence !== persistence) {
    cachedToken = null
  }
  if (cachedToken === null) {
    cachedToken = readTokenFile()
  }
  cachedPersistence = persistence

  return { token: cachedToken, persistence }
}

export type IssueTokenResult =
  | { ok: true; state: LocalAgentReadingTokenState }
  | { ok: false; reason: "write-failed"; message: string }

/**
 * Mints a token and replaces any previous one. Without a keyring the token only lives in this
 * session; the returned state says so.
 */
export const issueToken = (): IssueTokenResult => {
  const token = createToken()

  if (!isSecureStorageAvailable()) {
    sessionToken = token
    cachedToken = token
    cachedPersistence = "memory"
    return { ok: true, state: { token, persistence: "memory" } }
  }

  try {
    // 0600 is honoured on creation, so the encrypted blob is not readable by other users.
    writeFileSync(tokenFilePath(), safeStorage.encryptString(token), { mode: 0o600 })
  } catch (error) {
    return {
      ok: false,
      reason: "write-failed",
      message: error instanceof Error ? error.message : "Could not write the token file",
    }
  }

  sessionToken = null
  cachedToken = token
  cachedPersistence = "os-keyring"
  return { ok: true, state: { token, persistence: "os-keyring" } }
}

/** Drops the token; a request holding the old one is refused from now on. */
export const revokeToken = (): void => {
  sessionToken = null
  cachedToken = null
  cachedPersistence = null
  try {
    rmSync(tokenFilePath(), { force: true })
  } catch (error) {
    console.error("[local-agent-reading] could not remove the stored token:", error)
  }
}

/** Constant-time check of a presented bearer token against the one currently issued. */
export const matchesCurrentToken = (candidate: string): boolean => {
  const { token } = readToken()
  if (!token || !candidate) return false
  return tokensMatch(token, candidate)
}

/** Test hook: forget any cached token without touching the file store. */
export const resetTokenCache = (): void => {
  sessionToken = null
  cachedToken = null
  cachedPersistence = null
}
