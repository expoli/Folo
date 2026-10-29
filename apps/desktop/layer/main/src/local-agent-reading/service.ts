/**
 * The service behind the loopback endpoint.
 *
 * It decides what an agent may see, and it is the only place that knows both halves of the answer:
 * the account the app is signed in to (main process) and the data of that account (renderer, through
 * the data provider). Every tool call therefore starts by verifying the account, and anything that
 * changes that answer — sign-out, another account, the switch turned off, a new token — drops the
 * scans and cancels the calls that are still running.
 *
 * Nothing runs between calls: there is no background sync, and a scan is a bounded, one-shot
 * enumeration that the agent starts itself.
 */
import type {
  LocalAgentReadingAccountDescription,
  LocalAgentReadingBeginScanArgs,
  LocalAgentReadingContentMode,
  LocalAgentReadingContentsArgs,
  LocalAgentReadingListArgs,
  LocalAgentReadingScanSummary,
  LocalAgentReadingSettingsStatus,
  LocalAgentReadingStatusResult,
  LocalAgentReadingTokenReveal,
  LocalAgentReadingToolErrorCode,
} from "@follow/shared/local-agent-reading"
import {
  LOCAL_AGENT_READING_CONTRACT_VERSION,
  LOCAL_AGENT_READING_HOST,
  LOCAL_AGENT_READING_LIMITS,
  LOCAL_AGENT_READING_PORT,
  LOCAL_AGENT_READING_SERVICE_NAME,
  LOCAL_AGENT_READING_SOURCE_PAGE_DISABLED_MESSAGE,
  LOCAL_AGENT_READING_UNSUPPORTED_SCOPES,
  LOCAL_AGENT_READING_VIEWS,
  localAgentReadingEndpointUrl,
} from "@follow/shared/local-agent-reading"

import type { LocalAgentReadingAccountResolver } from "./account"
import type { SourcePageFetcher } from "./contents"
import { resolveContentMode, resolveContents } from "./contents"
import type { LocalAgentReadingDataProvider } from "./provider"
import type { ListScanOutcome, ScansOptions } from "./scans"
import { LocalAgentReadingScans, toScanSummary } from "./scans"
import type { LocalAgentReadingServerHandle, LoopbackServerOptions, ToolAnswer } from "./server"
import { createLocalAgentReadingServer } from "./server"
import type { IssueTokenResult, LocalAgentReadingTokenState } from "./token"
import { issueToken, readToken, revokeToken } from "./token"

export interface LocalAgentReadingTokenAccess {
  read: () => LocalAgentReadingTokenState
  issue: () => IssueTokenResult
  revoke: () => void
}

export interface LocalAgentReadingServiceOptions {
  provider: LocalAgentReadingDataProvider
  resolveAccount: LocalAgentReadingAccountResolver
  /** Persisted switch of the settings UI. */
  isEnabled: () => boolean
  setEnabledFlag: (enabled: boolean) => void
  /** Persisted permission for `source_page` reads; absent means off. */
  isSourcePageEnabled: () => boolean
  setSourcePageEnabledFlag: (enabled: boolean) => void
  tokens?: LocalAgentReadingTokenAccess
  port?: number
  log?: (line: string) => void
  now?: () => number
  fetchSourcePage?: SourcePageFetcher
  scans?: ScansOptions["limits"]
  serverLimits?: LoopbackServerOptions["limits"]
}

const toolError = (
  code: LocalAgentReadingToolErrorCode,
  message: string,
): { ok: false; error: { code: LocalAgentReadingToolErrorCode; message: string } } => ({
  ok: false,
  error: { code, message },
})

export class LocalAgentReadingService {
  private readonly provider: LocalAgentReadingDataProvider
  private readonly resolveAccount: LocalAgentReadingAccountResolver
  private readonly isEnabled: () => boolean
  private readonly setEnabledFlag: (enabled: boolean) => void
  private readonly isSourcePageEnabled: () => boolean
  private readonly setSourcePageEnabledFlag: (enabled: boolean) => void
  private readonly tokens: LocalAgentReadingTokenAccess
  private readonly log: (line: string) => void
  private readonly now: () => number
  private readonly fetchSourcePage?: SourcePageFetcher
  private readonly port: number
  private readonly scans: LocalAgentReadingScans
  private readonly server: LocalAgentReadingServerHandle

  /** Tool calls still running; cancelled when the account or the service changes under them. */
  private readonly inFlight = new Set<AbortController>()
  /** The subset of `inFlight` that may fetch article pages, so a revocation can abort only those. */
  private readonly sourcePageCalls = new Set<AbortController>()
  private listenError: string | null = null

  constructor(options: LocalAgentReadingServiceOptions) {
    this.provider = options.provider
    this.resolveAccount = options.resolveAccount
    this.isEnabled = options.isEnabled
    this.setEnabledFlag = options.setEnabledFlag
    this.isSourcePageEnabled = options.isSourcePageEnabled
    this.setSourcePageEnabledFlag = options.setSourcePageEnabledFlag
    this.tokens = options.tokens ?? { read: readToken, issue: issueToken, revoke: revokeToken }
    this.log = options.log ?? (() => {})
    this.now = options.now ?? Date.now
    this.fetchSourcePage = options.fetchSourcePage
    this.port = options.port ?? LOCAL_AGENT_READING_PORT

    this.scans = new LocalAgentReadingScans({
      provider: this.provider,
      now: this.now,
      log: this.log,
      ...(options.scans ? { limits: options.scans } : {}),
    })

    this.server = createLocalAgentReadingServer({
      tools: {
        status: () => this.status(),
        beginScan: (args) => this.beginScan(args),
        listEntries: (args) => this.listEntries(args),
        getContents: (args) => this.getContents(args),
      },
      getToken: () => this.tokens.read().token,
      port: this.port,
      log: this.log,
      now: this.now,
      ...(options.serverLimits ? { limits: options.serverLimits } : {}),
    })
  }

  /** Starts listening when the user left the switch on. A missing token keeps it off. */
  async start(): Promise<void> {
    if (!this.isEnabled()) return

    const { token } = this.tokens.read()
    if (!token) {
      // The token can be session-only (no OS keyring); it is gone after a restart and the user has
      // to mint a new one, which the settings status shows.
      this.log("[local-agent-reading] enabled but no token is issued; not listening")
      return
    }

    await this.listen()
  }

  async stop(): Promise<void> {
    this.invalidate("service stopped")
    await this.server.stop()
    this.listenError = null
  }

  /** Turns the endpoint on or off. Turning it off also revokes the token and drops every scan. */
  async setEnabled(enabled: boolean): Promise<LocalAgentReadingSettingsStatus> {
    this.setEnabledFlag(enabled)

    if (enabled) {
      if (!this.tokens.read().token) {
        const issued = this.tokens.issue()
        if (!issued.ok) {
          this.log(`[local-agent-reading] could not issue a token: ${issued.message}`)
        }
      }
      await this.listen()
    } else {
      this.invalidate("service disabled")
      this.tokens.revoke()
      await this.server.stop()
      this.listenError = null
    }

    return this.settingsStatus()
  }

  /** Mints a new token, so the previous one stops working immediately. */
  rotateToken(): LocalAgentReadingTokenReveal {
    if (!this.isEnabled()) {
      return {
        ok: false,
        token: null,
        persistence: this.tokens.read().persistence,
        reason: "service-disabled",
      }
    }

    this.invalidate("token rotated")
    this.tokens.revoke()
    const issued = this.tokens.issue()
    if (!issued.ok) {
      return {
        ok: false,
        token: null,
        persistence: this.tokens.read().persistence,
        reason: "write-failed",
      }
    }

    return {
      ok: true,
      token: issued.state.token,
      persistence: issued.state.persistence,
      reason: null,
    }
  }

  /** Drops the token without turning the endpoint off; every request is refused afterwards. */
  revokeToken(): LocalAgentReadingTokenReveal {
    this.invalidate("token revoked")
    this.tokens.revoke()
    return { ok: true, token: null, persistence: this.tokens.read().persistence, reason: null }
  }

  /** The token is only ever shown to the trusted settings window, never to an agent. */
  revealToken(): LocalAgentReadingTokenReveal {
    const state = this.tokens.read()
    if (!state.token) {
      return { ok: false, token: null, persistence: state.persistence, reason: "no-token" }
    }

    return { ok: true, token: state.token, persistence: state.persistence, reason: null }
  }

  settingsStatus(): LocalAgentReadingSettingsStatus {
    const token = this.tokens.read()
    return {
      enabled: this.isEnabled(),
      sourcePageEnabled: this.isSourcePageEnabled(),
      listening: this.server.isListening(),
      endpoint: this.server.endpoint(),
      tokenPresent: token.token !== null,
      tokenPersistence: token.persistence,
      listenError: this.listenError,
      contractVersion: LOCAL_AGENT_READING_CONTRACT_VERSION,
      limits: this.statusLimits(),
    }
  }

  /**
   * Sets the permission for `source_page` reads.
   *
   * Turning it off aborts the article page reads that are still running, so a page fetched under a
   * permission that no longer holds is not served; scans and cached/detail reads are untouched.
   */
  setSourcePageEnabled(enabled: boolean): LocalAgentReadingSettingsStatus {
    this.setSourcePageEnabledFlag(enabled)

    if (!enabled) {
      for (const controller of this.sourcePageCalls) {
        controller.abort(new DOMException("source pages turned off", "AbortError"))
      }
      this.sourcePageCalls.clear()
    }

    return this.settingsStatus()
  }

  /**
   * Drops scans and cancels running calls.
   *
   * Used for every event after which a pinned candidate list must not be served any more: sign-out,
   * an account switch, the switch turned off, a token change, or shutdown.
   */
  invalidate(reason: string): void {
    for (const controller of this.inFlight) {
      controller.abort(new DOMException(reason, "AbortError"))
    }
    this.inFlight.clear()
    this.sourcePageCalls.clear()

    const dropped = this.scans.clear()
    if (dropped > 0) {
      this.log(`[local-agent-reading] dropped ${dropped} scan(s): ${reason}`)
    }
  }

  // -------------------------------------------------------------------------
  // Tool handlers
  // -------------------------------------------------------------------------

  async status(): Promise<LocalAgentReadingStatusResult> {
    const account = await this.verifiedAccount()

    let description: LocalAgentReadingAccountDescription | null = null
    try {
      description = await this.provider.describeAccount()
    } catch (error) {
      this.log(`[local-agent-reading] status: renderer description failed: ${String(error)}`)
    }

    const accountMismatch =
      account.ok && description?.ok === true && description.accountId !== account.accountId
    if (accountMismatch) {
      // The renderer is signed in to another account than the session says: serve nothing.
      this.invalidate("account changed")
    }

    const rendererReady = description?.ok === true && description.ready && !accountMismatch
    const sources = description?.ok === true && !accountMismatch ? description.sources : []

    return {
      service: LOCAL_AGENT_READING_SERVICE_NAME,
      contractVersion: LOCAL_AGENT_READING_CONTRACT_VERSION,
      endpoint: {
        url: this.server.endpoint() ?? localAgentReadingEndpointUrl(this.port),
        host: LOCAL_AGENT_READING_HOST,
        port: this.servedPort(),
      },
      enabled: this.isEnabled(),
      sourcePageEnabled: this.isSourcePageEnabled(),
      ready: account.ok && rendererReady,
      signedIn: account.ok ? true : account.signedOut ? false : "unknown",
      account: account.ok ? { id: account.accountId, checkedAt: account.checkedAt } : null,
      renderer:
        description?.ok === true && !accountMismatch
          ? { ready: description.ready, syncedAt: description.syncedAt }
          : null,
      sources,
      views: LOCAL_AGENT_READING_VIEWS.map((view) => ({ value: view.value, label: view.label })),
      unsupportedScopes: [...LOCAL_AGENT_READING_UNSUPPORTED_SCOPES],
      scans: {
        active: this.scans.activeCount,
        max: LOCAL_AGENT_READING_LIMITS.maxScans,
        ttlMs: LOCAL_AGENT_READING_LIMITS.scanTtlMs,
      },
      limits: this.statusLimits(),
      listenError: this.listenError,
    }
  }

  /**
   * Starts a scan of the unread entries of the signed-in account.
   *
   * `requireListening` is what tells the two callers apart: the loopback endpoint can only answer
   * while it listens, while the app's own chat tools read the same data without the user having to
   * expose a port on the machine.
   */
  async beginScan(
    args: LocalAgentReadingBeginScanArgs,
    options: { requireListening?: boolean } = {},
  ): Promise<ToolAnswer<LocalAgentReadingScanSummary>> {
    const account = await this.verifiedAccount()
    if (!account.ok) return toolError(account.code, account.message)
    if (options.requireListening !== false && !this.server.isListening()) {
      return toolError("SERVICE_DISABLED", "The reading endpoint is not listening")
    }

    const controller = this.beginCall()
    try {
      const description = await this.provider.describeAccount({ signal: controller.signal })
      if (!description.ok) {
        return toolError("APP_NOT_READY", description.error.message)
      }
      if (description.accountId !== account.accountId) {
        this.invalidate("account changed")
        return toolError("ACCOUNT_CHANGED", "The signed-in account changed; scan again")
      }
      if (!description.ready) {
        return toolError(
          "APP_NOT_READY",
          "Folo has not finished loading the account; try again in a moment",
        )
      }

      const scan = await this.scans.begin({
        accountId: account.accountId,
        scope: args.scope ?? {},
        signal: controller.signal,
      })
      if (!scan.ok) {
        return toolError(
          scan.error.code === "PROVIDER_UNAVAILABLE" ? "PROVIDER_UNAVAILABLE" : "INVALID_REQUEST",
          scan.error.message,
        )
      }

      return { ok: true, data: toScanSummary(scan.scan) }
    } finally {
      this.endCall(controller)
    }
  }

  async listEntries(args: LocalAgentReadingListArgs) {
    const account = await this.verifiedAccount()
    if (!account.ok) return toolError(account.code, account.message)

    const listed: ListScanOutcome = this.scans.list({
      scanId: args.scanId,
      accountId: account.accountId,
      ...(args.cursor ? { cursor: args.cursor } : {}),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    })
    if (!listed.ok) return toolError(listed.error.code, listed.error.message)

    return {
      ok: true as const,
      data: {
        scan: toScanSummary(listed.scan),
        entries: listed.entries,
        cursor: listed.cursor,
        hasMore: listed.hasMore,
      },
    }
  }

  async getContents(args: LocalAgentReadingContentsArgs) {
    const account = await this.verifiedAccount()
    if (!account.ok) return toolError(account.code, account.message)

    const found = this.scans.get({ scanId: args.scanId, accountId: account.accountId })
    if (!found.ok) return toolError(found.error.code, found.error.message)

    const mode: LocalAgentReadingContentMode = args.mode ?? "cached"
    const entryIds = args.entryIds ?? []

    if (entryIds.length === 0 && !args.cursor) {
      return toolError("INVALID_REQUEST", "Name the entries to read, or a cursor to continue")
    }
    if (entryIds.length > LOCAL_AGENT_READING_LIMITS.maxContentBatch) {
      return toolError(
        "INVALID_REQUEST",
        `At most ${LOCAL_AGENT_READING_LIMITS.maxContentBatch} entries can be read at once`,
      )
    }

    // The mode a call reads in is the one the cursor carries too, so the permission is checked on
    // the effective mode: omitting `mode` on a continuation cannot reach the page fetcher.
    const effectiveMode = resolveContentMode({ mode, cursor: args.cursor ?? null })
    if (effectiveMode === "source_page" && !this.isSourcePageEnabled()) {
      return toolError("SOURCE_PAGE_DISABLED", LOCAL_AGENT_READING_SOURCE_PAGE_DISABLED_MESSAGE)
    }

    const controller = this.beginCall()
    if (effectiveMode === "source_page") this.sourcePageCalls.add(controller)
    try {
      const result = await resolveContents({
        scanId: found.scan.id,
        accountId: account.accountId,
        candidates: found.scan.candidates,
        mode,
        entryIds,
        cursor: args.cursor ?? null,
        provider: this.provider,
        signal: controller.signal,
        now: this.now,
        isSourcePageEnabled: () => this.isSourcePageEnabled(),
        ...(this.fetchSourcePage ? { fetchSourcePage: this.fetchSourcePage } : {}),
      })

      return { ok: true as const, data: result }
    } finally {
      this.endCall(controller)
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async listen(): Promise<void> {
    const started = await this.server.start()
    this.listenError = started.ok ? null : started.message
  }

  /** Port of the listening socket, or the configured one while it is not listening. */
  private servedPort(): number {
    return this.server.port() ?? this.port
  }

  private statusLimits() {
    return {
      maxEntriesPerScan: LOCAL_AGENT_READING_LIMITS.maxEntriesPerScan,
      defaultListLimit: LOCAL_AGENT_READING_LIMITS.defaultListLimit,
      maxListLimit: LOCAL_AGENT_READING_LIMITS.maxListLimit,
      defaultContentBatch: LOCAL_AGENT_READING_LIMITS.defaultContentBatch,
      maxContentBatch: LOCAL_AGENT_READING_LIMITS.maxContentBatch,
      contentChunkChars: LOCAL_AGENT_READING_LIMITS.contentChunkChars,
    }
  }

  private beginCall(): AbortController {
    const controller = new AbortController()
    this.inFlight.add(controller)
    return controller
  }

  private endCall(controller: AbortController): void {
    this.inFlight.delete(controller)
    this.sourcePageCalls.delete(controller)
  }

  /**
   * Confirms which account the app is signed in to right now.
   *
   * `signedOut` and `unknown` are kept apart: only a real 401 is reported as signed out, and a
   * session that could not be checked never turns into "you have no unread entries".
   */
  private async verifiedAccount(): Promise<
    | { ok: true; accountId: string; checkedAt: string; signedOut?: never }
    | { ok: false; signedOut: boolean; code: LocalAgentReadingToolErrorCode; message: string }
  > {
    const resolution = await this.resolveAccount()

    if (resolution.kind === "signed-in") {
      return { ok: true, accountId: resolution.accountId, checkedAt: resolution.checkedAt }
    }

    if (resolution.kind === "signed-out") {
      this.invalidate("signed out")
      return {
        ok: false,
        signedOut: true,
        code: "NOT_SIGNED_IN",
        message: "Folo is not signed in",
      }
    }

    return {
      ok: false,
      signedOut: false,
      code: "ACCOUNT_UNAVAILABLE",
      message: `The account could not be checked: ${resolution.reason}`,
    }
  }
}
