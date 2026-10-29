import type { LocalAgentReadingEntriesResult } from "@follow/shared/local-agent-reading"
import { describe, expect, test, vi } from "vitest"

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/folo-local-agent-reading-service-test" },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (buffer: Buffer) => buffer.toString(),
  },
}))

const { LocalAgentReadingService } = await import("./service")
const { candidateEntry, enumerationPage } = await import("./test-doubles")

interface HarnessOptions {
  enabled?: boolean
  hasToken?: boolean
  ready?: boolean
  account?:
    | { kind: "signed-in"; accountId: string }
    | { kind: "signed-out" }
    | { kind: "unknown"; reason: string }
  rendererAccountId?: string
  resolveEntries?: (signal: AbortSignal | undefined) => Promise<LocalAgentReadingEntriesResult>
  /** Backing store shared by two service instances to model an app restart. */
  settings?: { enabled?: boolean; sourcePageEnabled?: boolean }
  /** Initial value of the persisted article page permission. */
  sourcePageEnabled?: boolean
  fetchSourcePage?: (
    url: string,
    options: { signal?: AbortSignal; timeoutMs: number },
  ) => Promise<{ ok: true; text: string } | { ok: false; reason: "blocked" }>
}

const harness = (options: HarnessOptions = {}) => {
  const settings = options.settings ?? {}
  settings.enabled ??= options.enabled ?? true
  settings.sourcePageEnabled ??= options.sourcePageEnabled ?? false
  let token: string | null = options.hasToken === false ? null : "folo_lar_test-token"
  let issued = 0
  let resolveCalls = 0

  const service = new LocalAgentReadingService({
    provider: {
      async describeAccount() {
        return {
          ok: true,
          accountId: options.rendererAccountId ?? "acct-1",
          ready: options.ready ?? true,
          syncedAt: null,
          sources: [{ kind: "view", id: "0", label: "Articles", status: "complete" }],
        }
      },
      async enumerateUnread(request) {
        return enumerationPage({
          accountId: request.accountId,
          entries: [candidateEntry({ id: "entry-1" })],
        })
      },
      async resolveEntries(request) {
        resolveCalls += 1
        if (options.resolveEntries) return options.resolveEntries(request.signal)
        return {
          ok: true,
          accountId: request.accountId,
          entries: request.entryIds.map((entryId) => ({
            entryId,
            title: entryId,
            content: "text",
            contentFormat: "markdown" as const,
            contentSource: "rss" as const,
            completeness: "complete" as const,
            fetchedAt: "2026-10-02T00:00:00.000Z",
            error: null,
          })),
        }
      },
    },
    resolveAccount: async () => {
      const account = options.account ?? { kind: "signed-in" as const, accountId: "acct-1" }
      const checkedAt = new Date().toISOString()
      if (account.kind === "signed-in") return { ...account, checkedAt }
      if (account.kind === "signed-out") return { kind: "signed-out", checkedAt }
      return { kind: "unknown", checkedAt, reason: account.reason }
    },
    isEnabled: () => settings.enabled === true,
    setEnabledFlag: (next: boolean) => {
      settings.enabled = next
    },
    isSourcePageEnabled: () => settings.sourcePageEnabled === true,
    setSourcePageEnabledFlag: (next: boolean) => {
      settings.sourcePageEnabled = next
    },
    tokens: {
      read: () => ({ token, persistence: "memory" as const }),
      issue: () => {
        issued += 1
        token = `folo_lar_issued-${issued}`
        return { ok: true as const, state: { token, persistence: "memory" as const } }
      },
      revoke: () => {
        token = null
      },
    },
    port: 0,
    ...(options.fetchSourcePage ? { fetchSourcePage: options.fetchSourcePage } : {}),
  })

  return {
    service,
    status: () => service.settingsStatus(),
    token: () => token,
    issuedTokens: () => issued,
    resolveCalls: () => resolveCalls,
    settings,
  }
}

const started = async (options: HarnessOptions = {}) => {
  const created = harness(options)
  await created.service.start()
  return created
}

describe("service lifecycle", () => {
  test("does nothing while the switch is off", async () => {
    const app = await started({ enabled: false })

    expect(app.status()).toMatchObject({ enabled: false, listening: false, endpoint: null })
    await app.service.stop()
  })

  test("serves a scan to the app's own tools while the endpoint stays closed", async () => {
    // The chat panel reads the same data without the user exposing a port; only the endpoint gate
    // may be waived, so the two callers are checked against the same service instance.
    const app = await started({ enabled: false })
    expect(app.status()).toMatchObject({ listening: false })

    const viaApp = await app.service.beginScan({}, { requireListening: false })
    expect(viaApp.ok).toBe(true)

    const viaEndpoint = await app.service.beginScan({})
    expect(viaEndpoint.ok).toBe(false)
    if (viaEndpoint.ok) return
    expect(viaEndpoint.error.code).toBe("SERVICE_DISABLED")

    await app.service.stop()
  })

  test("does not listen when the switch is on but no token could be stored", async () => {
    // A session-only token is gone after a restart; serving an endpoint nobody can authenticate to
    // would be a silent failure, so the status says the token is missing instead.
    const app = await started({ hasToken: false })

    expect(app.status()).toMatchObject({ enabled: true, listening: false, tokenPresent: false })
    await app.service.stop()
  })

  test("turning it on starts listening with the token already stored", async () => {
    const app = harness({ enabled: false })
    const status = await app.service.setEnabled(true)

    expect(status).toMatchObject({ enabled: true, listening: true, tokenPresent: true })
    expect(status.endpoint).toContain("127.0.0.1")
    // A token that is already issued is kept, so an agent's configuration keeps working.
    expect(app.issuedTokens()).toBe(0)

    await app.service.stop()
  })

  test("turning it on mints a token when none is stored", async () => {
    const app = harness({ enabled: false, hasToken: false })
    const status = await app.service.setEnabled(true)

    expect(status).toMatchObject({ enabled: true, listening: true, tokenPresent: true })
    expect(app.issuedTokens()).toBe(1)

    await app.service.stop()
  })

  test("turning it off revokes the token and closes the socket", async () => {
    const app = await started()
    expect(app.status().listening).toBe(true)

    const status = await app.service.setEnabled(false)

    expect(status).toMatchObject({ enabled: false, listening: false, tokenPresent: false })
    expect(app.token()).toBeNull()
  })
})

describe("token controls", () => {
  test("reveals the token to the trusted window", async () => {
    const app = await started()

    expect(app.service.revealToken()).toMatchObject({ ok: true, token: "folo_lar_test-token" })
    await app.service.stop()
  })

  test("does not reveal a token for a disabled service", async () => {
    const app = harness({ enabled: false, hasToken: false })
    await app.service.start()

    expect(app.service.revealToken()).toMatchObject({ ok: false, reason: "no-token" })
    expect(app.service.rotateToken()).toMatchObject({ ok: false, reason: "service-disabled" })
    await app.service.stop()
  })

  test("rotating replaces the token without touching the switch", async () => {
    const app = await started()
    const rotated = app.service.rotateToken()

    expect(rotated).toMatchObject({ ok: true, persistence: "memory" })
    expect(rotated.token).not.toBe("folo_lar_test-token")
    expect(app.status()).toMatchObject({ enabled: true, listening: true, tokenPresent: true })
    await app.service.stop()
  })

  test("revoking keeps the endpoint up but refuses every request", async () => {
    const app = await started()
    const revoked = app.service.revokeToken()

    expect(revoked).toMatchObject({ ok: true, token: null })
    expect(app.status()).toMatchObject({ listening: true, tokenPresent: false })
    await app.service.stop()
  })
})

describe("account binding", () => {
  test("status reports a signed-out account as signed out, never as an empty account", async () => {
    const app = await started({ account: { kind: "signed-out" } })
    const status = await app.service.status()

    expect(status).toMatchObject({ signedIn: false, ready: false, account: null })
    await app.service.stop()
  })

  test("a session that cannot be checked stays unknown", async () => {
    const app = await started({ account: { kind: "unknown", reason: "network down" } })
    const status = await app.service.status()

    expect(status.signedIn).toBe("unknown")
    expect(status.ready).toBe(false)
    await app.service.stop()
  })

  test("a renderer on another account than the session serves nothing", async () => {
    const app = await started({ rendererAccountId: "acct-2" })
    const status = await app.service.status()

    expect(status.ready).toBe(false)
    await app.service.stop()
  })

  test("the app not being ready is reported, not turned into an empty scan", async () => {
    const app = await started({ ready: false })
    const answer = await app.service.beginScan({})

    expect(answer.ok).toBe(false)
    if (answer.ok) return
    expect(answer.error.code).toBe("APP_NOT_READY")
    await app.service.stop()
  })
})

describe("article page permission", () => {
  const scanOf = async (app: ReturnType<typeof harness>) => {
    const scan = await app.service.beginScan({})
    if (!scan.ok) throw new Error(`scan refused: ${scan.error.code}`)
    return scan.data.scanId
  }

  test("article pages are off by default, whatever the account offers", async () => {
    const app = await started()

    expect(app.status()).toMatchObject({ sourcePageEnabled: false })
    expect((await app.service.status()).sourcePageEnabled).toBe(false)
    await app.service.stop()
  })

  test("asking for a page while it is off is refused before anything is read", async () => {
    const fetchSourcePage = vi.fn(async () => ({ ok: true as const, text: "Page text" }))
    const app = await started({ fetchSourcePage })
    const scanId = await scanOf(app)

    const answer = await app.service.getContents({
      scanId,
      entryIds: ["entry-1"],
      mode: "source_page",
    })

    expect(answer.ok).toBe(false)
    if (answer.ok) return
    expect(answer.error.code).toBe("SOURCE_PAGE_DISABLED")
    expect(answer.error.message).toContain("cached or detail")
    expect(fetchSourcePage).not.toHaveBeenCalled()
    // The refusal costs no provider round trip either.
    expect(app.resolveCalls()).toBe(0)

    await app.service.stop()
  })

  test("a continuation cursor cannot reach the fetcher either", async () => {
    const fetchSourcePage = vi.fn(async () => ({ ok: true as const, text: "Page text" }))
    const app = await started({ fetchSourcePage })
    const scanId = await scanOf(app)

    // The cursor carries `source_page`; `mode` is omitted, as a client would on the second call.
    const answer = await app.service.getContents({ scanId, cursor: "c1:source_page:0:entry-1" })

    expect(answer.ok).toBe(false)
    if (answer.ok) return
    expect(answer.error.code).toBe("SOURCE_PAGE_DISABLED")
    expect(fetchSourcePage).not.toHaveBeenCalled()

    await app.service.stop()
  })

  test("allowing article pages serves the page and keeps the choice across a restart", async () => {
    const settings: { enabled?: boolean; sourcePageEnabled?: boolean } = {}
    const fetchSourcePage = vi.fn(async (url: string) => ({
      ok: true as const,
      text: `Page of ${url}`,
    }))
    const first = await started({ settings, fetchSourcePage })
    const scanId = await scanOf(first)

    expect(first.service.setSourcePageEnabled(true)).toMatchObject({ sourcePageEnabled: true })

    const answer = await first.service.getContents({
      scanId,
      entryIds: ["entry-1"],
      mode: "source_page",
    })
    expect(answer.ok).toBe(true)
    if (!answer.ok) return
    expect(answer.data.items[0]).toMatchObject({
      contentSource: "source_page",
      content: "Page of https://example.com/entry-1",
    })
    expect(first.settings.sourcePageEnabled).toBe(true)
    await first.service.stop()

    // The same stored value is what the next start reads.
    const second = await started({ settings })
    expect(second.status().sourcePageEnabled).toBe(true)
    await second.service.stop()
  })

  test("turning it off aborts a running page read and never serves the late page", async () => {
    let releasePage: ((value: { ok: true; text: string }) => void) | null = null
    const fetchSourcePage = vi.fn(
      () =>
        new Promise<{ ok: true; text: string }>((resolve) => {
          releasePage = resolve
        }),
    )
    const app = await started({ sourcePageEnabled: true, fetchSourcePage })
    const scanId = await scanOf(app)

    const reading = app.service.getContents({
      scanId,
      entryIds: ["entry-1"],
      mode: "source_page",
    })
    // Let the read reach the page fetcher before the permission is revoked.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetchSourcePage).toHaveBeenCalledTimes(1)

    app.service.setSourcePageEnabled(false)
    // The page answers anyway; that text must not be served.
    releasePage!({ ok: true, text: "Late page text" })

    const result = await reading
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.items[0]!.content).not.toBe("Late page text")
    expect(result.data.items[0]!.contentSource).toBe("rss")
    expect(result.data.items[0]!.warning?.code).toBe("source_page_unavailable")

    // Nothing new is fetched after the revocation.
    const refused = await app.service.getContents({
      scanId,
      entryIds: ["entry-1"],
      mode: "source_page",
    })
    expect(refused.ok).toBe(false)
    expect(fetchSourcePage).toHaveBeenCalledTimes(1)

    await app.service.stop()
  })

  test("cached and detail reads are untouched by the permission", async () => {
    const app = await started({ sourcePageEnabled: false })
    const scanId = await scanOf(app)

    const cached = await app.service.getContents({ scanId, entryIds: ["entry-1"], mode: "cached" })
    expect(cached.ok).toBe(true)
    if (!cached.ok) return
    expect(cached.data.items[0]).toMatchObject({ contentSource: "rss", content: "text" })

    const detail = await app.service.getContents({ scanId, entryIds: ["entry-1"], mode: "detail" })
    expect(detail.ok).toBe(true)
    if (!detail.ok) return
    expect(detail.data.items[0]).toMatchObject({ contentSource: "rss", content: "text" })

    await app.service.stop()
  })
})

describe("cancellation", () => {
  test("turning the service off aborts a running read", async () => {
    const app = await started({
      resolveEntries: (signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () =>
            resolve({ ok: false, error: { code: "CANCELLED", message: "cancelled" } }),
          )
        }),
    })

    const scan = await app.service.beginScan({})
    expect(scan.ok).toBe(true)
    if (!scan.ok) return

    const reading = app.service.getContents({
      scanId: scan.data.scanId,
      entryIds: ["entry-1"],
      mode: "detail",
    })
    // Let the read reach the provider before the account changes under it.
    await new Promise((resolve) => setTimeout(resolve, 20))
    app.service.invalidate("test")

    const result = await reading
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.items[0]!.error?.code).toBe("timeout")

    await app.service.stop()
  })
})
