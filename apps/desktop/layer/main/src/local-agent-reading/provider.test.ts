import type {
  LocalAgentReadingAccountDescription,
  LocalAgentReadingEnumerationPage,
} from "@follow/shared/local-agent-reading"
import { afterEach, describe, expect, test, vi } from "vitest"

import type { ProviderRequest } from "./provider"
import { createRendererDataProvider } from "./provider"

const fakeWindow = () => ({
  isDestroyed: () => false,
  webContents: {
    isDestroyed: () => false,
    executeJavaScript: vi.fn(async () => undefined),
  },
})

type FakeWindow = ReturnType<typeof fakeWindow>

const provider = (
  options: {
    window?: FakeWindow | null
    invoke?: Parameters<typeof createRendererDataProvider>[0]["invoke"]
    timeoutMs?: number
  } = {},
) =>
  createRendererDataProvider({
    getWindow: () => (options.window === undefined ? fakeWindow() : options.window) as never,
    ...(options.invoke ? { invoke: options.invoke } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })

const page: LocalAgentReadingEnumerationPage = {
  ok: true,
  accountId: "acct-1",
  entries: [
    {
      id: "entry-1",
      title: "First",
      url: "https://example.com/1",
      feedId: "feed-1",
      publishedAt: "2026-10-01T00:00:00.000Z",
      readState: "unread",
      readStateObservedAt: "2026-10-02T00:00:00.000Z",
      hasCachedContent: false,
      source: "feed",
    },
  ],
  cursor: null,
  sources: [],
  errors: [],
  observedAt: "2026-10-02T00:00:00.000Z",
}

afterEach(() => {
  vi.useRealTimers()
})

describe("renderer data provider", () => {
  test("refuses to ask when the main window is gone", async () => {
    const result = await provider({ window: null }).enumerateUnread({
      accountId: "acct-1",
      scope: {},
      cursor: null,
      limit: 10,
    })

    expect(result).toEqual({
      ok: false,
      error: { code: "APP_NOT_READY", message: expect.stringContaining("window is not open") },
    })
  })

  test("reads a not-ready renderer as APP_NOT_READY, never as an empty page", async () => {
    // The bridge answers `undefined` when the renderer has not registered the method yet.
    const result = await provider({ invoke: async () => undefined }).enumerateUnread({
      accountId: "acct-1",
      scope: {},
      cursor: null,
      limit: 10,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("APP_NOT_READY")
  })

  test("returns the page the renderer produced", async () => {
    const result = await provider({ invoke: async () => page }).enumerateUnread({
      accountId: "acct-1",
      scope: { views: [0] },
      cursor: null,
      limit: 10,
    })

    expect(result).toEqual(page)
  })

  test("forwards the account to the renderer and refuses another account's answer", async () => {
    const sent: ProviderRequest[] = []
    const invoke: NonNullable<Parameters<typeof createRendererDataProvider>[0]["invoke"]> = async (
      _expose,
      request,
    ) => {
      sent.push(request)
      return { ...page, accountId: "acct-2" }
    }

    const result = await provider({ invoke }).enumerateUnread({
      accountId: "acct-1",
      scope: {},
      cursor: null,
      limit: 10,
    })

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      method: "localAgentReadingEnumerateUnread",
      payload: { accountId: "acct-1", limit: 10, cursor: null },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("ACCOUNT_MISMATCH")
  })

  test("refuses a data answer that does not name its account", async () => {
    const result = await provider({
      invoke: async () => ({ ...page, accountId: undefined }),
    }).enumerateUnread({ accountId: "acct-1", scope: {}, cursor: null, limit: 10 })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("RENDERER_UNAVAILABLE")
  })

  test("keeps the renderer's own refusal when it has no account to name", async () => {
    // Signing out mid-scan leaves the renderer with no account to echo. That refusal is the honest
    // answer; replacing it with "the renderer is unavailable" would hide the sign-out.
    const refusal = {
      ok: false as const,
      error: { code: "APP_NOT_READY" as const, message: "Folo is not signed in" },
    }

    const result = await provider({ invoke: async () => refusal }).enumerateUnread({
      accountId: "acct-1",
      scope: {},
      cursor: null,
      limit: 10,
    })

    expect(result).toEqual(refusal)
  })

  test("keeps the renderer's own refusal of a content batch", async () => {
    const refusal = {
      ok: false as const,
      error: { code: "APP_NOT_READY" as const, message: "Folo is not signed in" },
    }

    const result = await provider({ invoke: async () => refusal }).resolveEntries({
      accountId: "acct-1",
      entryIds: ["entry-1"],
      includeDetail: false,
    })

    expect(result).toEqual(refusal)
  })

  test("does not pass on a refusal it cannot read", async () => {
    const result = await provider({
      invoke: async () => ({ ok: false, error: "the renderer threw", accountId: undefined }),
    }).enumerateUnread({ accountId: "acct-1", scope: {}, cursor: null, limit: 10 })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("RENDERER_UNAVAILABLE")
    expect(result.error.message).not.toContain("the renderer threw")
  })

  test("still refuses a refusal that names another account", async () => {
    const result = await provider({
      invoke: async () => ({
        ok: false,
        error: { code: "APP_NOT_READY", message: "Folo is not signed in" },
        accountId: "acct-2",
      }),
    }).enumerateUnread({ accountId: "acct-1", scope: {}, cursor: null, limit: 10 })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("ACCOUNT_MISMATCH")
  })

  test("refuses a candidate entry it cannot read instead of dropping it", async () => {
    const result = await provider({
      invoke: async () => ({ ...page, entries: [{ id: "entry-1" }] }),
    }).enumerateUnread({ accountId: "acct-1", scope: {}, cursor: null, limit: 10 })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("INVALID_REQUEST")
  })

  test("times out a renderer that never answers and asks it to stop", async () => {
    const window = fakeWindow()
    const result = await provider({
      window,
      timeoutMs: 10,
      invoke: () => new Promise(() => {}),
    }).enumerateUnread({ accountId: "acct-1", scope: {}, cursor: null, limit: 10 })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("TIMEOUT")
    expect(window.webContents.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining("localAgentReadingCancel"),
    )
  })

  test("a cancelled call reports cancellation and stops the renderer work", async () => {
    const window = fakeWindow()
    const controller = new AbortController()
    const running = provider({
      window,
      invoke: () => new Promise(() => {}),
    }).enumerateUnread({
      accountId: "acct-1",
      scope: {},
      cursor: null,
      limit: 10,
      signal: controller.signal,
    })

    controller.abort()

    const result = await running
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("CANCELLED")
    expect(window.webContents.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining("localAgentReadingCancel"),
    )
  })

  test("passes a renderer refusal through unchanged", async () => {
    const description: LocalAgentReadingAccountDescription = {
      ok: false,
      error: { code: "APP_NOT_READY", message: "The account has not loaded yet" },
    }

    const result = await provider({ invoke: async () => description }).describeAccount()
    expect(result).toEqual(description)
  })

  test("describes the account the renderer is showing", async () => {
    const description: LocalAgentReadingAccountDescription = {
      ok: true,
      accountId: "acct-1",
      ready: true,
      syncedAt: "2026-10-02T00:00:00.000Z",
      sources: [{ kind: "view", id: "0", label: "Articles", status: "complete" }],
    }

    const result = await provider({ invoke: async () => description }).describeAccount()
    expect(result).toEqual(description)
  })
})
