/**
 * Contract of the local agent reading service.
 *
 * An external agent running on the same machine reads the unread entries of the signed-in Folo
 * account through a loopback-only MCP endpoint. The endpoint is served by the desktop main
 * process, which never hands out the login session: the agent authenticates with a dedicated,
 * revocable token and every request is bound to the account that was signed in when the scan
 * started.
 *
 * Three layers share this file:
 * - the main process serves MCP tools and owns scans, tokens and resource limits;
 * - the renderer supplies paginated account data and entry content through the narrow bridge
 *   described by `LocalAgentReadingBridge` (see `bridge.ts`);
 * - the settings UI only reaches the token and the on/off switch.
 *
 * Everything that crosses the bridge is plain JSON (the bridge serializes arguments), so dates are
 * ISO-8601 strings and provider calls answer with a discriminated result instead of throwing.
 */
import { z } from "zod"

/** Bumped when a tool's request or response shape changes incompatibly. */
export const LOCAL_AGENT_READING_CONTRACT_VERSION = 1

export const LOCAL_AGENT_READING_SERVICE_NAME = "folo-local-agent-reading"

/** Path of the MCP endpoint. Only this path is answered. */
export const LOCAL_AGENT_READING_ENDPOINT_PATH = "/mcp"

/**
 * The service listens on this fixed port: an external agent needs a stable URL to be configured
 * with once. A port that is already taken is reported as a listen failure instead of silently
 * moving the endpoint somewhere the agent does not look.
 */
export const LOCAL_AGENT_READING_PORT = 41_610
export const LOCAL_AGENT_READING_HOST = "127.0.0.1"

export const LOCAL_AGENT_READING_LIMITS = {
  /** Scans kept at the same time; the oldest is dropped when a new one needs room. */
  maxScans: 4,
  /** Candidates one scan may pin; beyond this the scan reports itself as truncated. */
  maxEntriesPerScan: 2000,
  /** Entries asked from the renderer per enumeration page. */
  enumerationPageSize: 100,
  /** Time one scan may spend enumerating before it is reported as incomplete. */
  enumerationBudgetMs: 60_000,
  /** A scan keeps its fixed candidate list for this long. */
  scanTtlMs: 15 * 60_000,
  defaultListLimit: 50,
  maxListLimit: 100,
  defaultContentBatch: 5,
  maxContentBatch: 10,
  /** Characters of one content chunk; longer texts continue through `nextCursor`. */
  contentChunkChars: 6000,
  /** One provider round trip (renderer enumeration or entry resolution). */
  providerRequestTimeoutMs: 20_000,
  /** Source pages fetched at the same time in `source_page` mode. */
  sourcePageConcurrency: 4,
  sourcePageTimeoutMs: 12_000,
  maxRequestBodyBytes: 256 * 1024,
  requestsPerMinute: 120,
  /** Tool calls served at the same time; the rest is answered as busy. */
  maxConcurrentToolCalls: 2,
} as const

/** Views of the Folo timeline; the numbers are `FeedViewType` of the client SDK. */
export const LOCAL_AGENT_READING_VIEWS = [
  { value: 0, label: "articles" },
  { value: 1, label: "social-media" },
  { value: 2, label: "pictures" },
  { value: 3, label: "videos" },
  { value: 4, label: "audios" },
] as const

/** Sources the service can enumerate. Anything else is disclosed as unsupported. */
export const LOCAL_AGENT_READING_SUPPORTED_SOURCES = ["view", "inbox", "feed"] as const

/** Sources the first version deliberately does not read, reported by `folo_get_status`. */
export const LOCAL_AGENT_READING_UNSUPPORTED_SCOPES = [
  "search results",
  "uncollected / archived entries",
  "entries kept only in a local cache that the account API no longer returns",
] as const

/**
 * Refusal of a `source_page` read while the user has not allowed article pages.
 *
 * `source_page` is the only mode that leaves the account API, so it is gated by a permission the
 * agent cannot set; the refusal names the other modes the agent may ask for instead.
 */
export const LOCAL_AGENT_READING_SOURCE_PAGE_DISABLED_MESSAGE =
  "Article page fetching is turned off in Folo's settings; use the cached or detail mode"

// ---------------------------------------------------------------------------
// Read state and candidates
// ---------------------------------------------------------------------------

/**
 * Read state of a candidate. `unknown` is *not* unread: an entry whose state could not be observed
 * is counted separately and never enters the candidate list.
 */
export type LocalAgentReadingReadState = "unread" | "unknown"

/** One pinned candidate of a scan. */
export interface LocalAgentReadingCandidateEntry {
  id: string
  title: string
  url: string | null
  /** Feed the entry came from; `null` for entries of an inbox. */
  feedId: string | null
  publishedAt: string | null
  readState: LocalAgentReadingReadState
  /** When the read state was observed; the state is an observation, not a live value. */
  readStateObservedAt: string
  /** True when text is already available without asking the account API for the detail. */
  hasCachedContent: boolean
  source: "feed" | "inbox"
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * Which part of the account a scan covers. Omitted fields mean "everything this build supports":
 * no `views`/`feedIds` means every subscribed view, no `inboxIds` means every inbox of the
 * account.
 */
export interface LocalAgentReadingScope {
  /** `FeedViewType` values (-1 for "all" is accepted and expanded by the provider). */
  views?: number[]
  feedIds?: string[]
  inboxIds?: string[]
  publishedAfter?: string
  publishedBefore?: string
}

export type LocalAgentReadingSourceKind = (typeof LOCAL_AGENT_READING_SUPPORTED_SOURCES)[number]

/**
 * `complete`: every page of the source was read for this scan.
 * `partial`: the source answered but part of it was skipped (an error, or the scan budget).
 * `failed`: the source could not be read at all.
 * `unsupported`: the client cannot enumerate this source.
 */
export type LocalAgentReadingSourceStatus =
  "complete" | "partial" | "failed" | "unsupported" | "not_attempted"

export interface LocalAgentReadingSourceProgress {
  kind: LocalAgentReadingSourceKind
  /** View number as a string, inbox id, or feed id. */
  id: string
  label: string | null
  status: LocalAgentReadingSourceStatus
  /** Entries this source contributed before cross-source de-duplication. */
  observedCount: number
  error: string | null
}

// ---------------------------------------------------------------------------
// Renderer provider (bridge) contract
// ---------------------------------------------------------------------------

export type LocalAgentReadingProviderErrorCode =
  | "APP_NOT_READY"
  | "ACCOUNT_MISMATCH"
  | "CANCELLED"
  | "TIMEOUT"
  | "INVALID_REQUEST"
  | "UPSTREAM_ERROR"
  /** The renderer answered something the main process cannot use (or failed while answering). */
  | "RENDERER_UNAVAILABLE"

export interface LocalAgentReadingProviderError {
  code: LocalAgentReadingProviderErrorCode
  message: string
}

export interface LocalAgentReadingAccountRequest {
  /** Correlation id; the renderer must echo it in nothing, but main cancels by it. */
  requestId: string
}

export interface LocalAgentReadingSourceCapability {
  kind: LocalAgentReadingSourceKind
  id: string
  label: string | null
  status: LocalAgentReadingSourceStatus
}

export type LocalAgentReadingAccountDescription =
  | {
      ok: true
      accountId: string
      /** The renderer data layer is hydrated and can answer enumeration right now. */
      ready: boolean
      /** Last successful sync of the account, when the client knows it. */
      syncedAt: string | null
      sources: LocalAgentReadingSourceCapability[]
    }
  | { ok: false; error: LocalAgentReadingProviderError; accountId?: string }

export interface LocalAgentReadingEnumerationRequest {
  requestId: string
  /** Account the main process verified; a different one is an account switch. */
  accountId: string
  scope: LocalAgentReadingScope
  /** Opaque cursor from the previous page; `null` starts the enumeration. */
  cursor: string | null
  limit: number
}

export interface LocalAgentReadingEnumerationError {
  source: string
  code: string
  message: string
}

export type LocalAgentReadingEnumerationPage =
  | {
      ok: true
      accountId: string
      entries: LocalAgentReadingCandidateEntry[]
      /** Opaque cursor for the next page; `null` when the enumeration is finished. */
      cursor: string | null
      sources: LocalAgentReadingSourceProgress[]
      errors: LocalAgentReadingEnumerationError[]
      observedAt: string
    }
  | { ok: false; error: LocalAgentReadingProviderError; accountId?: string }

/** Where the text of an entry came from; they are not interchangeable reports of "the article". */
export type LocalAgentReadingContentSource = "rss" | "readability" | "description" | "source_page"

export type LocalAgentReadingContentFormat = "markdown" | "text" | "html"

/** How complete the text is *as a statement about the source article*. */
export type LocalAgentReadingCompleteness = "complete" | "partial" | "unknown"

export type LocalAgentReadingEntryErrorCode = "not_found" | "no_content" | "unavailable"

export interface LocalAgentReadingResolvedEntry {
  entryId: string
  /** Title and URL of the pinned candidate come from the scan; only the text is resolved here. */
  title: string | null
  /** Text the account already holds (`cached`) or that the detail API returned (`detail`). */
  content: string | null
  contentFormat: LocalAgentReadingContentFormat | null
  contentSource: LocalAgentReadingContentSource | null
  completeness: LocalAgentReadingCompleteness
  fetchedAt: string
  error: { code: LocalAgentReadingEntryErrorCode; message: string } | null
}

export interface LocalAgentReadingEntriesRequest {
  requestId: string
  accountId: string
  entryIds: string[]
  /** `true` asks the renderer to call the entry detail API for entries without text. */
  includeDetail: boolean
}

export type LocalAgentReadingEntriesResult =
  | { ok: true; accountId: string; entries: LocalAgentReadingResolvedEntry[] }
  | { ok: false; error: LocalAgentReadingProviderError; accountId?: string }

export interface LocalAgentReadingCancelRequest {
  requestId: string
}

/**
 * Methods the renderer registers on the global bridge (`useRegisterGlobalContext`) and the main
 * process calls on the main window only. They must never throw: a rejected promise, a missing
 * registration or `null` is read by the main process as "the renderer is not ready" and no account
 * data is served.
 */
export interface LocalAgentReadingBridge {
  localAgentReadingDescribeAccount: (
    request: LocalAgentReadingAccountRequest,
  ) => Promise<LocalAgentReadingAccountDescription | null>
  localAgentReadingEnumerateUnread: (
    request: LocalAgentReadingEnumerationRequest,
  ) => Promise<LocalAgentReadingEnumerationPage | null>
  localAgentReadingResolveEntries: (
    request: LocalAgentReadingEntriesRequest,
  ) => Promise<LocalAgentReadingEntriesResult | null>
  /** Best effort: the renderer stops work it can stop; main discards the answer either way. */
  localAgentReadingCancel: (request: LocalAgentReadingCancelRequest) => void
}

// ---------------------------------------------------------------------------
// MCP tool results
// ---------------------------------------------------------------------------

export interface LocalAgentReadingAccountInfo {
  id: string
  /** When the account was last verified against the session API. */
  checkedAt: string
}

export interface LocalAgentReadingStatusResult {
  service: typeof LOCAL_AGENT_READING_SERVICE_NAME
  contractVersion: number
  endpoint: { url: string; host: string; port: number }
  enabled: boolean
  /** Whether the user allows the `source_page` mode; it is independent of `enabled`. */
  sourcePageEnabled: boolean
  /** True when both the renderer and the account can answer a scan right now. */
  ready: boolean
  /** `unknown` means the session could not be checked; it is never reported as signed out. */
  signedIn: boolean | "unknown"
  account: LocalAgentReadingAccountInfo | null
  renderer: { ready: boolean; syncedAt: string | null } | null
  sources: LocalAgentReadingSourceCapability[]
  /** Timeline views the endpoint accepts in a scan scope. */
  views: { value: number; label: string }[]
  unsupportedScopes: string[]
  scans: { active: number; max: number; ttlMs: number }
  limits: {
    maxEntriesPerScan: number
    defaultListLimit: number
    maxListLimit: number
    defaultContentBatch: number
    maxContentBatch: number
    contentChunkChars: number
  }
  /** Set when the endpoint could not be started (e.g. the port is taken). */
  listenError: string | null
}

export type LocalAgentReadingScanStatus = "complete" | "partial" | "failed"

export type LocalAgentReadingScanErrorCode =
  | "source_failed"
  | "source_unsupported"
  | "scan_limit_reached"
  | "enumeration_budget_exhausted"
  | "provider_unavailable"
  | "account_changed"
  | "cancelled"

export interface LocalAgentReadingScanError {
  code: LocalAgentReadingScanErrorCode
  message: string
  source: string | null
}

/** What a scan found and how far it can be trusted. */
export interface LocalAgentReadingScanSummary {
  scanId: string
  accountId: string
  scope: LocalAgentReadingScope
  startedAt: string
  finishedAt: string | null
  expiresAt: string
  status: LocalAgentReadingScanStatus
  /**
   * True only when every supported source reached the end of its pagination. The client cannot
   * prove an atomic snapshot, so a complete enumeration is still a *best effort* selection.
   */
  enumerationComplete: boolean
  selectionConsistency: "best_effort"
  selectedCount: number
  duplicatesRemoved: number
  /** Entries seen with a read state that could not be observed; they are never served. */
  unknownReadStateCount: number
  sources: LocalAgentReadingSourceProgress[]
  errors: LocalAgentReadingScanError[]
}

export interface LocalAgentReadingScanPageResult {
  scan: LocalAgentReadingScanSummary
  entries: LocalAgentReadingCandidateEntry[]
  cursor: string | null
  hasMore: boolean
}

export type LocalAgentReadingContentErrorCode =
  | "not_in_scan"
  | "entry_not_found"
  | "no_content"
  | "unsupported_media"
  | "blocked_destination"
  | "fetch_failed"
  | "paywall_or_too_short"
  | "timeout"

/** A request answered with less than it asked for, but with usable text. */
export type LocalAgentReadingContentWarningCode =
  | "detail_unavailable"
  | "source_page_unavailable"
  | "partial_content"
  | "length_unknown"
  | "cursor_out_of_range"

export interface LocalAgentReadingContentItem {
  entryId: string
  title: string | null
  url: string | null
  /** `null` when nothing could be read. */
  contentSource: LocalAgentReadingContentSource | null
  contentType: LocalAgentReadingContentFormat | null
  completeness: LocalAgentReadingCompleteness
  fetchedAt: string
  content: string
  /** The text continues; pass `nextCursor` to read the rest. */
  truncated: boolean
  nextCursor: string | null
  warning: { code: LocalAgentReadingContentWarningCode; message: string } | null
  /** Set when this entry could not be read at all. */
  error: { code: LocalAgentReadingContentErrorCode; message: string } | null
}

/**
 * `cached` reads only what the account already holds, `detail` may call the entry detail API,
 * `source_page` additionally fetches the article page through the guarded public-only fetcher —
 * and only while the user has allowed article pages in Folo's settings.
 */
export type LocalAgentReadingContentMode = "cached" | "detail" | "source_page"

export interface LocalAgentReadingContentsResult {
  scanId: string
  mode: LocalAgentReadingContentMode
  items: LocalAgentReadingContentItem[]
  counts: {
    requested: number
    returned: number
    failed: number
    /** Items whose text continues in `nextCursor`. */
    continued: number
  }
  /** Ids the caller asked for that are not candidates of this scan. */
  rejectedEntryIds: string[]
}

// ---------------------------------------------------------------------------
// Settings surface (trusted renderer only)
// ---------------------------------------------------------------------------

export type LocalAgentReadingTokenPersistence = "os-keyring" | "memory"

export interface LocalAgentReadingSettingsStatus {
  enabled: boolean
  /** Permission for `source_page` reads; persisted separately and off until the user allows it. */
  sourcePageEnabled: boolean
  listening: boolean
  endpoint: string | null
  tokenPresent: boolean
  tokenPersistence: LocalAgentReadingTokenPersistence
  listenError: string | null
  contractVersion: number
  limits: LocalAgentReadingStatusResult["limits"]
}

export interface LocalAgentReadingTokenReveal {
  ok: boolean
  token: string | null
  persistence: LocalAgentReadingTokenPersistence
  reason: "service-disabled" | "write-failed" | "no-token" | null
}

// ---------------------------------------------------------------------------
// Tool input schemas
//
// Shared with the MCP tool registration so the validation the agent sees and the validation the
// service enforces cannot drift apart.
// ---------------------------------------------------------------------------

const isoDateSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "expected an ISO-8601 date")

export const localAgentReadingScopeSchema = z
  .object({
    views: z.array(z.number().int().min(-1).max(5)).max(8).optional(),
    feedIds: z.array(z.string().min(1).max(128)).max(50).optional(),
    inboxIds: z.array(z.string().min(1).max(128)).max(50).optional(),
    publishedAfter: isoDateSchema.optional(),
    publishedBefore: isoDateSchema.optional(),
  })
  .strict()

export const localAgentReadingBeginScanArgsSchema = z
  .object({
    scope: localAgentReadingScopeSchema.optional(),
  })
  .strict()

export const localAgentReadingListArgsSchema = z
  .object({
    scanId: z.string().min(1).max(128),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.number().int().min(1).max(LOCAL_AGENT_READING_LIMITS.maxListLimit).optional(),
  })
  .strict()

export const localAgentReadingContentsArgsSchema = z
  .object({
    scanId: z.string().min(1).max(128),
    entryIds: z
      .array(z.string().min(1).max(128))
      .max(LOCAL_AGENT_READING_LIMITS.maxContentBatch)
      .optional(),
    mode: z.enum(["cached", "detail", "source_page"]).optional(),
    /** Continuation of one entry: the cursor returned as `nextCursor`. */
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict()

export type LocalAgentReadingBeginScanArgs = z.infer<typeof localAgentReadingBeginScanArgsSchema>
export type LocalAgentReadingListArgs = z.infer<typeof localAgentReadingListArgsSchema>
export type LocalAgentReadingContentsArgs = z.infer<typeof localAgentReadingContentsArgsSchema>

/**
 * Why a tool could not answer. These are refusals the agent can act on (sign in, wait for the app,
 * start a new scan) rather than protocol errors.
 */
export type LocalAgentReadingToolErrorCode =
  | "NOT_SIGNED_IN"
  | "ACCOUNT_UNAVAILABLE"
  | "ACCOUNT_CHANGED"
  | "APP_NOT_READY"
  | "SERVICE_DISABLED"
  | "SCAN_NOT_FOUND"
  | "SCAN_EXPIRED"
  | "INVALID_REQUEST"
  | "PROVIDER_UNAVAILABLE"
  | "SOURCE_PAGE_DISABLED"
  | "STATUS_FAILED"
  | "INTERNAL_ERROR"

/** Names of the tools the endpoint serves. There is deliberately no mark-as-read tool. */
export const LOCAL_AGENT_READING_TOOL_NAMES = [
  "folo_get_status",
  "folo_begin_unread_scan",
  "folo_list_scan_entries",
  "folo_get_entry_contents",
] as const

export type LocalAgentReadingToolName = (typeof LOCAL_AGENT_READING_TOOL_NAMES)[number]

/** URL an agent is configured with. */
export const localAgentReadingEndpointUrl = (port = LOCAL_AGENT_READING_PORT) =>
  `http://${LOCAL_AGENT_READING_HOST}:${port}${LOCAL_AGENT_READING_ENDPOINT_PATH}`
