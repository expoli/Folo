/**
 * The account description the endpoint re-reads on every tool call.
 */
import { describe, expect, it } from "vitest"

import { describeAccount } from "./account"
import type { LocalAgentReadingDeps } from "./types"

const ACCOUNT = "account-1"

const createDeps = (overrides: Partial<LocalAgentReadingDeps> = {}): LocalAgentReadingDeps => ({
  getAccountId: () => ACCOUNT,
  listInboxIds: () => [],
  getSourceLabel: () => null,
  listSourcePage: async () => [],
  getReadOverlay: () => null,
  getStoredEntries: async () => [],
  loadEntryDetail: async () => null,
  loadEntryReadability: async () => null,
  now: () => Date.parse("2026-10-20T10:00:00.000Z"),
  ...overrides,
})

describe("describeAccount", () => {
  it("reports the account and every source the scan can page", async () => {
    const description = await describeAccount(
      createDeps({
        listInboxIds: () => ["inbox-a"],
        getSourceLabel: (source) =>
          source.kind === "inbox" ? "Newsletters" : `${source.kind} ${source.id}`,
      }),
    )

    expect(description).toMatchObject({ ok: true, accountId: ACCOUNT, ready: true })
    // The client knows a change-log cursor, not the time of the last sync: it says nothing.
    if (description.ok) expect(description.syncedAt).toBeNull()

    const sources = description.ok ? description.sources : []
    expect(sources.map((source) => `${source.kind}:${source.id}`)).toEqual([
      "view:0",
      "view:1",
      "view:2",
      "view:3",
      "view:4",
      "inbox:inbox-a",
    ])
    expect(sources.every((source) => source.status === "complete")).toBe(true)
    expect(sources.at(-1)?.label).toBe("Newsletters")
  })

  it("answers that the app is not ready while no account is signed in", async () => {
    const description = await describeAccount(createDeps({ getAccountId: () => null }))
    expect(description.ok).toBe(false)
    if (!description.ok) expect(description.error.code).toBe("APP_NOT_READY")
  })
})
