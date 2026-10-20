/**
 * The account the local agent reading service reads, wired to what the app already has.
 *
 * Account data comes from the same authenticated client the timeline uses, so an external agent
 * never sees a second source of truth: no login credential leaves this process, and nothing here
 * writes — enumeration, entry text and read state are all reads. Pending local read changes are
 * layered on top of the snapshot, because the user already sees their effect in the app.
 */
import { EntryService } from "@follow/database/services/entry"
import { api } from "@follow/store/context"
import { getFeedById } from "@follow/store/feed/getter"
import { getInboxList } from "@follow/store/inbox/getters"
import { getSubscriptionById } from "@follow/store/subscription/getter"
import { entryReadOverlayKey } from "@follow/store/sync/overlay-keys"
import { transactionQueue } from "@follow/store/sync/transaction-queue"
import { whoami } from "@follow/store/user/getters"

import { viewLabel } from "./plan"
import type {
  ListSourcePageInput,
  LocalAgentReadingDeps,
  PlannedSource,
  SourcePageItem,
  StoredEntryText,
} from "./types"

const toIsoString = (value: unknown): string | null => {
  if (typeof value === "string") {
    return Number.isNaN(Date.parse(value)) ? null : value
  }
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null
}

const toRead = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null)

const pageItem = ({
  entry,
  feedId,
  read,
}: {
  entry: { id: string; title: string | null; url: string | null; publishedAt: unknown }
  feedId: string | null
  read: unknown
}): SourcePageItem => ({
  id: entry.id,
  title: entry.title ?? null,
  url: entry.url ?? null,
  feedId,
  publishedAt: toIsoString(entry.publishedAt),
  read: toRead(read),
})

/** One page of one source, newest first, of the unread entries the account still keeps. */
const listSourcePage = async ({
  source,
  cursor,
  limit,
  signal,
}: ListSourcePageInput): Promise<SourcePageItem[]> => {
  const pagination = cursor ? { publishedAfter: cursor } : {}

  if (source.kind === "inbox") {
    const response = await api().entries.inbox.list(
      { inboxId: source.id, read: false, limit, ...pagination },
      { signal },
    )
    return (response.data ?? []).map((item) =>
      pageItem({ entry: item.entries, feedId: null, read: item.read }),
    )
  }

  const response = await api().entries.list(
    {
      ...(source.kind === "feed" ? { feedId: source.id } : { view: Number(source.id) }),
      read: false,
      limit,
      sortOrder: "desc",
      ...pagination,
    },
    { signal },
  )
  return (response.data ?? []).map((item) =>
    pageItem({ entry: item.entries, feedId: item.feeds?.id ?? null, read: item.read }),
  )
}

const getAccountId = () => whoami()?.id ?? null

const listInboxIds = () => getInboxList().map((inbox) => inbox.id)

const getSourceLabel = (source: PlannedSource): string | null => {
  if (source.kind === "view") return viewLabel(source.id)
  if (source.kind === "inbox") {
    return getInboxList().find((inbox) => inbox.id === source.id)?.title ?? null
  }
  return getSubscriptionById(source.id)?.title ?? getFeedById(source.id)?.title ?? null
}

const getReadOverlay = (entryId: string): boolean | null => {
  const value = transactionQueue.getOverlays().get(entryReadOverlayKey(entryId))
  return typeof value === "boolean" ? value : null
}

const getStoredEntries = async (entryIds: string[]): Promise<StoredEntryText[]> => {
  if (entryIds.length === 0) return []
  const rows = await EntryService.getEntryMany(entryIds)
  return rows.map((row) => ({
    id: row.id,
    inboxHandle: row.inboxHandle ?? null,
    content: row.content ?? null,
    readabilityContent: row.readabilityContent ?? null,
    readabilityUpdatedAt: row.readabilityUpdatedAt?.toISOString() ?? null,
    description: row.description ?? null,
  }))
}

const contentOf = (data: { entries: { content?: string | null } } | null | undefined) =>
  data?.entries.content ?? null

/**
 * RSS text from the detail API. The app's own detail fetch is not used: it also writes the entry
 * into the store with `read: false`, and reading must never touch read state.
 */
const loadEntryDetail = async (
  entryId: string,
  isInbox: boolean | null,
): Promise<string | null> => {
  if (isInbox === true) {
    return contentOf((await api().entries.inbox.get({ id: entryId })).data)
  }

  try {
    const content = contentOf((await api().entries.get({ id: entryId })).data)
    if (content) return content
  } catch (error) {
    if (isInbox === false) throw error
  }

  // An entry of an inbox is served by the inbox endpoint; without a local row both are tried.
  if (isInbox === false) return null
  try {
    return contentOf((await api().entries.inbox.get({ id: entryId })).data)
  } catch {
    return null
  }
}

const loadEntryReadability = async (entryId: string): Promise<string | null> => {
  const response = await api().entries.readability({ id: entryId })
  return response.data?.content ?? null
}

export const createLocalAgentReadingDeps = (): LocalAgentReadingDeps => ({
  getAccountId,
  listInboxIds,
  getSourceLabel,
  listSourcePage,
  getReadOverlay,
  getStoredEntries,
  loadEntryDetail,
  loadEntryReadability,
  now: Date.now,
})
