/**
 * Test doubles for the local agent reading tests.
 *
 * Only tests import this file: it records what the service asked for and answers with what the test
 * scripted, so the behaviour of the endpoint can be checked without a renderer or an account.
 */
import type {
  LocalAgentReadingAccountDescription,
  LocalAgentReadingCandidateEntry,
  LocalAgentReadingEntriesResult,
  LocalAgentReadingEnumerationPage,
} from "@follow/shared/local-agent-reading"

import type {
  DescribeAccountOptions,
  EnumerateUnreadRequest,
  LocalAgentReadingDataProvider,
  ResolveEntriesRequest,
} from "./provider"

export interface ProviderCalls {
  describe: DescribeAccountOptions[]
  enumerate: EnumerateUnreadRequest[]
  resolve: ResolveEntriesRequest[]
}

export interface SyntheticProvider {
  provider: LocalAgentReadingDataProvider
  calls: ProviderCalls
}

export const candidateEntry = (
  overrides: Partial<LocalAgentReadingCandidateEntry> & { id: string },
): LocalAgentReadingCandidateEntry => ({
  title: overrides.title ?? `Title ${overrides.id}`,
  url: overrides.url ?? `https://example.com/${overrides.id}`,
  feedId: overrides.feedId ?? "feed-1",
  publishedAt: overrides.publishedAt ?? "2026-10-01T00:00:00.000Z",
  readState: overrides.readState ?? "unread",
  readStateObservedAt: overrides.readStateObservedAt ?? "2026-10-02T00:00:00.000Z",
  hasCachedContent: overrides.hasCachedContent ?? false,
  source: overrides.source ?? "feed",
  ...overrides,
})

/** The successful half of an enumeration page, so a page cannot accidentally claim `ok: false`. */
type EnumerationPageFields = Partial<
  Omit<Extract<LocalAgentReadingEnumerationPage, { ok: true }>, "ok">
>

export const enumerationPage = (
  overrides: EnumerationPageFields & { accountId: string },
): LocalAgentReadingEnumerationPage => ({
  ok: true,
  entries: [],
  cursor: null,
  sources: [],
  errors: [],
  observedAt: "2026-10-02T00:00:00.000Z",
  ...overrides,
})

export const accountDescription = (
  overrides: Partial<Extract<LocalAgentReadingAccountDescription, { ok: true }>> = {},
): LocalAgentReadingAccountDescription => ({
  ok: true,
  accountId: overrides.accountId ?? "acct-1",
  ready: overrides.ready ?? true,
  syncedAt: overrides.syncedAt ?? "2026-10-02T00:00:00.000Z",
  sources: overrides.sources ?? [{ kind: "view", id: "0", label: "Articles", status: "complete" }],
})

export const createSyntheticProvider = (
  handlers: {
    describeAccount?: (
      options: DescribeAccountOptions,
    ) => Promise<LocalAgentReadingAccountDescription>
    enumerateUnread?: (request: EnumerateUnreadRequest) => Promise<LocalAgentReadingEnumerationPage>
    resolveEntries?: (request: ResolveEntriesRequest) => Promise<LocalAgentReadingEntriesResult>
  } = {},
): SyntheticProvider => {
  const calls: ProviderCalls = { describe: [], enumerate: [], resolve: [] }

  const provider: LocalAgentReadingDataProvider = {
    async describeAccount(options = {}) {
      calls.describe.push(options)
      if (handlers.describeAccount) return handlers.describeAccount(options)
      return accountDescription()
    },
    async enumerateUnread(request) {
      calls.enumerate.push(request)
      if (handlers.enumerateUnread) return handlers.enumerateUnread(request)
      return enumerationPage({ accountId: request.accountId })
    },
    async resolveEntries(request) {
      calls.resolve.push(request)
      if (handlers.resolveEntries) return handlers.resolveEntries(request)
      return { ok: true, accountId: request.accountId, entries: [] }
    },
  }

  return { provider, calls }
}
