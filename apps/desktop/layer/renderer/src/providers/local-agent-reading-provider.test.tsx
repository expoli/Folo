/**
 * The provider publishes the reading bridge on `globalThis.__follow`, which is exactly how the main
 * process reaches the renderer. These tests go through the real bridge and the real account /
 * enumeration modules; only the account data is faked.
 */
import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

const account = vi.hoisted(() => ({
  id: "account-1" as string | null,
  pages: [] as {
    id: string
    title: string | null
    url: string | null
    feedId: string | null
    publishedAt: string | null
    read: boolean | null
  }[][],
}))

vi.mock("~/modules/local-agent-reading/deps", () => ({
  createLocalAgentReadingDeps: () => ({
    getAccountId: () => account.id,
    listInboxIds: () => [],
    getSourceLabel: () => null,
    listSourcePage: async () => {
      const next = account.pages.shift() ?? []
      return next
    },
    getReadOverlay: () => null,
    getStoredEntries: async () => [],
    loadEntryDetail: async () => null,
    loadEntryReadability: async () => null,
    now: () => Date.parse("2026-10-20T10:00:00.000Z"),
  }),
}))

const { LocalAgentReadingProvider } = await import("./local-agent-reading-provider")

type Bridge = {
  localAgentReadingDescribeAccount: (request: {
    requestId: string
  }) => Promise<{ ok: boolean; accountId?: string; error?: { code: string } }>
  localAgentReadingEnumerateUnread: (request: {
    requestId: string
    accountId: string
    scope: Record<string, unknown>
    cursor: string | null
    limit: number
  }) => Promise<{ ok: boolean; entries?: { id: string }[]; sources?: { id: string }[] }>
  localAgentReadingResolveEntries: (request: {
    requestId: string
    accountId: string
    entryIds: string[]
    includeDetail: boolean
  }) => Promise<{ ok: boolean }>
  localAgentReadingCancel: (request: { requestId: string }) => void
}

const bridge = () => (globalThis as unknown as { __follow: Bridge }).__follow

describe("LocalAgentReadingProvider", () => {
  let root: Root | null = null
  let container: HTMLElement | null = null

  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
      root = null
    }
    container?.remove()
    container = null
    account.id = "account-1"
    account.pages = []
  })

  const renderProvider = async () => {
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<LocalAgentReadingProvider />)
    })
  }

  it("registers the four methods the main process calls", async () => {
    await renderProvider()

    const registered = bridge()
    expect(typeof registered.localAgentReadingDescribeAccount).toBe("function")
    expect(typeof registered.localAgentReadingEnumerateUnread).toBe("function")
    expect(typeof registered.localAgentReadingResolveEntries).toBe("function")
    expect(typeof registered.localAgentReadingCancel).toBe("function")
  })

  it("answers the main process with the account and its sources", async () => {
    await renderProvider()

    const description = await bridge().localAgentReadingDescribeAccount({ requestId: "req-1" })
    expect(description.ok).toBe(true)
    expect(description.accountId).toBe("account-1")
  })

  it("serves one page of candidates", async () => {
    account.pages = [
      [
        {
          id: "entry-1",
          title: "An entry",
          url: "https://example.com/1",
          feedId: "feed-1",
          publishedAt: "2026-10-20T09:00:00.000Z",
          read: false,
        },
      ],
    ]
    await renderProvider()

    const page = await bridge().localAgentReadingEnumerateUnread({
      requestId: "req-2",
      accountId: "account-1",
      scope: { views: [0] },
      cursor: null,
      limit: 10,
    })

    expect(page.ok).toBe(true)
    expect(page.entries?.map((entry) => entry.id)).toEqual(["entry-1"])
    expect(page.sources?.map((source) => source.id)).toEqual(["0"])
  })

  it("reports a signed-out app instead of an account", async () => {
    account.id = null
    await renderProvider()

    const description = await bridge().localAgentReadingDescribeAccount({ requestId: "req-3" })
    expect(description.ok).toBe(false)
    expect(description.error?.code).toBe("APP_NOT_READY")
  })

  it("keeps a cancellation from throwing", async () => {
    await renderProvider()
    expect(() => bridge().localAgentReadingCancel({ requestId: "never-started" })).not.toThrow()
  })
})
