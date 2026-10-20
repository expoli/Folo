/**
 * What the renderer side of the local agent reading service needs from the account.
 *
 * The main process owns the endpoint, the token and the scan lifecycle; this side only pages the
 * account API and reads entry text (`@follow/shared/local-agent-reading` holds the contract that
 * crosses the bridge). Everything here is deliberately read-only: no local read state is written,
 * no entry reader is opened.
 */
import type { LocalAgentReadingSourceKind } from "@follow/shared/local-agent-reading"

/**
 * One source a scan pages through. `id` is a timeline view number as text, an inbox id, or a feed
 * id — the three kinds the shared contract lists as supported.
 */
export interface PlannedSource {
  kind: LocalAgentReadingSourceKind
  id: string
}

/** One row of an account page, reduced to what a pinned candidate needs. */
export interface SourcePageItem {
  id: string
  title: string | null
  url: string | null
  feedId: string | null
  publishedAt: string | null
  /** `null` when the answer does not say; an unobservable read state is not unread. */
  read: boolean | null
}

/** Text the account already holds for an entry, as the local database stores it. */
export interface StoredEntryText {
  id: string
  inboxHandle: string | null
  content: string | null
  readabilityContent: string | null
  /** When the reader text was extracted, ISO-8601; `null` when unknown. */
  readabilityUpdatedAt: string | null
  description: string | null
}

export interface ListSourcePageInput {
  source: PlannedSource
  /** Pagination cursor inside the source, as returned by the previous page. */
  cursor: string | null
  limit: number
  signal?: AbortSignal
}

/**
 * Everything the renderer contributes. Injected so the pagination and text rules can be tested
 * without an account, a database or an HTTP client.
 */
export interface LocalAgentReadingDeps {
  /** Id of the signed-in account, or `null` while the app has no session. */
  getAccountId: () => string | null
  listInboxIds: () => string[]
  getSourceLabel: (source: PlannedSource) => string | null
  /** One page of one source, newest first. Throws when the source cannot be read. */
  listSourcePage: (input: ListSourcePageInput) => Promise<SourcePageItem[]>
  /** Pending local read intent for this entry, if any: it wins over the server snapshot. */
  getReadOverlay: (entryId: string) => boolean | null
  getStoredEntries: (entryIds: string[]) => Promise<StoredEntryText[]>
  /**
   * RSS text of one entry from the detail API. `isInbox` selects the endpoint; `null` means the
   * local database does not say, so both are tried. Throws when the request fails.
   */
  loadEntryDetail: (entryId: string, isInbox: boolean | null) => Promise<string | null>
  /** Text the account's reader extracted for this entry. Throws when the request fails. */
  loadEntryReadability: (entryId: string) => Promise<string | null>
  now: () => number
}

export const sourceKey = (source: PlannedSource) => `${source.kind}:${source.id}`
