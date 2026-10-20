/**
 * The bridge the main process calls.
 *
 * Its two promises are: it never throws (the bridge would swallow an exception and read it as "the
 * app is not ready"), and a cancelled call stops instead of running for nobody.
 */
import { describe, expect, it, vi } from "vitest"

import { createLocalAgentReadingBridge } from "./bridge"
import { activeRequestCount } from "./cancel"
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

describe("createLocalAgentReadingBridge", () => {
  it("answers every method with a value, even when the account store throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const bridge = createLocalAgentReadingBridge(
        createDeps({
          getAccountId: () => {
            throw new Error("the store is not hydrated")
          },
        }),
      )

      const described = await bridge.localAgentReadingDescribeAccount({ requestId: "req-1" })
      const page = await bridge.localAgentReadingEnumerateUnread({
        requestId: "req-2",
        accountId: ACCOUNT,
        scope: {},
        cursor: null,
        limit: 10,
      })
      const entries = await bridge.localAgentReadingResolveEntries({
        requestId: "req-3",
        accountId: ACCOUNT,
        entryIds: ["entry-1"],
        includeDetail: false,
      })

      for (const answer of [described, page, entries]) {
        expect(answer).not.toBeNull()
        expect(answer?.ok).toBe(false)
        expect(answer && !answer.ok && answer.error.code).toBe("RENDERER_UNAVAILABLE")
      }
      // Nothing stays registered as in flight.
      expect(activeRequestCount()).toBe(0)
    } finally {
      error.mockRestore()
    }
  })

  it("stops a call the main process cancelled and forgets it afterwards", async () => {
    let started: () => void = () => {}
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    const bridge = createLocalAgentReadingBridge(
      createDeps({
        listSourcePage: ({ signal }) =>
          new Promise((_, reject) => {
            started()
            signal?.addEventListener(
              "abort",
              () => reject(new DOMException("cancelled", "AbortError")),
              { once: true },
            )
          }),
      }),
    )

    const pending = bridge.localAgentReadingEnumerateUnread({
      requestId: "req-cancel",
      accountId: ACCOUNT,
      scope: { views: [0] },
      cursor: null,
      limit: 10,
    })
    await running

    bridge.localAgentReadingCancel({ requestId: "req-cancel" })
    const page = await pending

    expect(page?.ok).toBe(false)
    expect(page && !page.ok && page.error.code).toBe("CANCELLED")
    expect(activeRequestCount()).toBe(0)
  })

  it("ignores a cancellation for a call that already finished", async () => {
    const bridge = createLocalAgentReadingBridge(createDeps())
    const page = await bridge.localAgentReadingEnumerateUnread({
      requestId: "req-done",
      accountId: ACCOUNT,
      scope: { views: [0] },
      cursor: null,
      limit: 10,
    })
    expect(page?.ok).toBe(true)

    expect(() => bridge.localAgentReadingCancel({ requestId: "req-done" })).not.toThrow()
    expect(activeRequestCount()).toBe(0)
  })
})
