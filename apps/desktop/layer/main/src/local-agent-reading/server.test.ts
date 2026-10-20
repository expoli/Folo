import { request as httpRequest } from "node:http"

import type {
  LocalAgentReadingEntriesResult,
  LocalAgentReadingEnumerationPage,
} from "@follow/shared/local-agent-reading"
import { LOCAL_AGENT_READING_TOOL_NAMES } from "@follow/shared/local-agent-reading"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/folo-local-agent-reading-server-test" },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (buffer: Buffer) => buffer.toString(),
  },
}))

const { LocalAgentReadingService } = await import("./service")
const { createToken } = await import("./token")
const { candidateEntry, enumerationPage } = await import("./test-doubles")

/**
 * A live service on an ephemeral port with a scripted account, so the transport, the guards and the
 * tools are exercised for real: the MCP client below speaks Streamable HTTP to 127.0.0.1.
 */
const startService = async (
  options: {
    accountId?: string
    ready?: boolean
    entries?: Parameters<typeof candidateEntry>[0][]
    rateLimit?: number
    maxRequestBodyBytes?: number
    maxConcurrentToolCalls?: number
    content?: string
    resolveEntries?: (entryIds: string[]) => Promise<LocalAgentReadingEntriesResult>
    sourcePageEnabled?: boolean
    fetchSourcePage?: (
      url: string,
      options: { signal?: AbortSignal; timeoutMs: number },
    ) => Promise<{ ok: true; text: string } | { ok: false; reason: "blocked" }>
  } = {},
) => {
  let currentAccount = options.accountId ?? "acct-1"
  let token: string | null = createToken()
  let signedIn = true
  let enabled = true
  let sourcePageEnabled = options.sourcePageEnabled ?? false

  const enumerate = async (request: {
    accountId: string
    cursor: string | null
    limit: number
  }): Promise<LocalAgentReadingEnumerationPage> => {
    const all = options.entries ?? [{ id: "entry-1" }, { id: "entry-2" }]
    // Two pages, so pagination of the enumeration itself is covered.
    const half = Math.ceil(all.length / 2)
    const pageIndex = request.cursor ? 1 : 0
    const page = pageIndex === 0 ? all.slice(0, half) : all.slice(half)

    return enumerationPage({
      accountId: request.accountId,
      entries: page.map((entry) => candidateEntry(entry)),
      cursor: pageIndex === 0 && all.length > half ? "page-2" : null,
      sources: [
        {
          kind: "view",
          id: "0",
          label: "Articles",
          status: pageIndex === 0 && all.length > half ? "partial" : "complete",
          observedCount: page.length,
          error: null,
        },
      ],
    })
  }

  const service = new LocalAgentReadingService({
    provider: {
      async describeAccount() {
        return {
          ok: true,
          accountId: currentAccount,
          ready: options.ready ?? true,
          syncedAt: "2026-10-02T00:00:00.000Z",
          sources: [{ kind: "view", id: "0", label: "Articles", status: "complete" }],
        }
      },
      enumerateUnread: enumerate,
      resolveEntries: async (request) =>
        options.resolveEntries
          ? options.resolveEntries(request.entryIds)
          : {
              ok: true,
              accountId: request.accountId,
              entries: request.entryIds.map((entryId) => ({
                entryId,
                title: `Title ${entryId}`,
                content: options.content ?? `Text of ${entryId}`,
                contentFormat: "markdown" as const,
                contentSource: "rss" as const,
                completeness: "complete" as const,
                fetchedAt: "2026-10-02T00:00:00.000Z",
                error: null,
              })),
            },
    },
    resolveAccount: async () =>
      signedIn
        ? { kind: "signed-in", accountId: currentAccount, checkedAt: new Date().toISOString() }
        : { kind: "signed-out", checkedAt: new Date().toISOString() },
    isEnabled: () => enabled,
    setEnabledFlag: (next: boolean) => {
      enabled = next
    },
    isSourcePageEnabled: () => sourcePageEnabled,
    setSourcePageEnabledFlag: (next: boolean) => {
      sourcePageEnabled = next
    },
    tokens: {
      read: () => ({ token, persistence: "memory" as const }),
      issue: () => {
        token = createToken()
        return { ok: true as const, state: { token, persistence: "memory" as const } }
      },
      revoke: () => {
        token = null
      },
    },
    port: 0,
    ...(options.fetchSourcePage ? { fetchSourcePage: options.fetchSourcePage } : {}),
    serverLimits: {
      maxRequestBodyBytes: options.maxRequestBodyBytes ?? 256 * 1024,
      requestsPerMinute: options.rateLimit ?? 100,
      maxConcurrentToolCalls: options.maxConcurrentToolCalls ?? 2,
    },
  })

  await service.setEnabled(true)

  return {
    service,
    status: () => service.settingsStatus(),
    getToken: (): string => token!,
    setToken: (next: string | null) => {
      token = next
    },
    signOut: () => {
      signedIn = false
    },
    switchAccount: (accountId: string) => {
      currentAccount = accountId
    },
    endpoint: () => service.settingsStatus().endpoint!,
    sourcePageEnabled: () => sourcePageEnabled,
  }
}

type RunningService = Awaited<ReturnType<typeof startService>>

const connect = async (url: string, token: string) => {
  const client = new Client({ name: "folo-test-agent", version: "0.0.1" })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return client
}

const payloadOf = (result: unknown) => {
  const content = (result as { content: { type: string; text: string }[] }).content
  return JSON.parse(content[0]!.text)
}

const running: RunningService[] = []

const started = async (
  options: Parameters<typeof startService>[0] = {},
): Promise<RunningService> => {
  const service = await startService(options)
  running.push(service)
  return service
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetch)
})

afterEach(async () => {
  await Promise.all(running.splice(0).map((service) => service.service.stop()))
  vi.unstubAllGlobals()
})

describe("loopback MCP endpoint", () => {
  test("handshakes and lists the read-only tools", async () => {
    const app = await started()
    const client = await connect(app.endpoint(), app.getToken()!)

    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name)).toEqual([...LOCAL_AGENT_READING_TOOL_NAMES])
    // Nothing in the tool list may change read state.
    expect(tools.tools.map((tool) => tool.name)).not.toContain("folo_mark_read")
    for (const tool of tools.tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true)
      expect(tool.annotations?.destructiveHint).toBe(false)
    }

    const status = payloadOf(await client.callTool({ name: "folo_get_status", arguments: {} }))
    expect(status).toMatchObject({
      service: "folo-local-agent-reading",
      enabled: true,
      ready: true,
      signedIn: true,
      account: { id: "acct-1" },
      renderer: { ready: true },
      scans: { active: 0 },
    })
    // No credentials of the account are handed out.
    expect(JSON.stringify(status)).not.toMatch(/cookie|token|session/i)

    await client.close()
  })

  test("scans, pages the entries and reads their contents", async () => {
    const app = await started()
    const client = await connect(app.endpoint(), app.getToken()!)

    const scan = payloadOf(
      await client.callTool({
        name: "folo_begin_unread_scan",
        arguments: { scope: { views: [0] } },
      }),
    )
    expect(scan).toMatchObject({
      status: "complete",
      enumerationComplete: true,
      selectionConsistency: "best_effort",
      selectedCount: 2,
      accountId: "acct-1",
    })

    const firstPage = payloadOf(
      await client.callTool({
        name: "folo_list_scan_entries",
        arguments: { scanId: scan.scanId, limit: 1 },
      }),
    )
    expect(firstPage.entries).toHaveLength(1)
    expect(firstPage.hasMore).toBe(true)

    const secondPage = payloadOf(
      await client.callTool({
        name: "folo_list_scan_entries",
        arguments: { scanId: scan.scanId, limit: 1, cursor: firstPage.cursor },
      }),
    )
    expect(secondPage.entries).toHaveLength(1)
    expect(secondPage.hasMore).toBe(false)

    const contents = payloadOf(
      await client.callTool({
        name: "folo_get_entry_contents",
        arguments: {
          scanId: scan.scanId,
          entryIds: [firstPage.entries[0].id, secondPage.entries[0].id],
          mode: "cached",
        },
      }),
    )
    expect(contents.mode).toBe("cached")
    expect(contents.counts).toEqual({ requested: 2, returned: 2, failed: 0, continued: 0 })
    expect(contents.items[0]).toMatchObject({
      contentSource: "rss",
      completeness: "complete",
      content: `Text of ${firstPage.entries[0].id}`,
    })

    await client.close()
  })

  test("an id that is not part of the scan is refused, not invented", async () => {
    const app = await started()
    const client = await connect(app.endpoint(), app.getToken()!)

    const scan = payloadOf(await client.callTool({ name: "folo_begin_unread_scan", arguments: {} }))
    const contents = payloadOf(
      await client.callTool({
        name: "folo_get_entry_contents",
        arguments: { scanId: scan.scanId, entryIds: ["not-a-candidate"] },
      }),
    )

    expect(contents.rejectedEntryIds).toEqual(["not-a-candidate"])
    expect(contents.items).toEqual([])
    expect(contents.counts.returned).toBe(0)

    await client.close()
  })

  test("article pages are fetched only after the user allows them", async () => {
    const fetchSourcePage = vi.fn(async (url: string) => ({
      ok: true as const,
      text: `Page of ${url}`,
    }))
    const app = await started({ fetchSourcePage })
    const client = await connect(app.endpoint(), app.getToken()!)

    const status = payloadOf(await client.callTool({ name: "folo_get_status", arguments: {} }))
    expect(status.sourcePageEnabled).toBe(false)

    const scan = payloadOf(await client.callTool({ name: "folo_begin_unread_scan", arguments: {} }))

    const refused = await client.callTool({
      name: "folo_get_entry_contents",
      arguments: { scanId: scan.scanId, entryIds: ["entry-1"], mode: "source_page" },
    })
    expect(refused.isError).toBe(true)
    expect(payloadOf(refused).error.code).toBe("SOURCE_PAGE_DISABLED")
    expect(fetchSourcePage).not.toHaveBeenCalled()

    // A continuation cursor names the mode, so omitting `mode` is not a way around the permission.
    const bypass = await client.callTool({
      name: "folo_get_entry_contents",
      arguments: { scanId: scan.scanId, cursor: "c1:source_page:0:entry-1" },
    })
    expect(bypass.isError).toBe(true)
    expect(payloadOf(bypass).error.code).toBe("SOURCE_PAGE_DISABLED")
    expect(fetchSourcePage).not.toHaveBeenCalled()

    app.service.setSourcePageEnabled(true)
    const allowed = payloadOf(
      await client.callTool({
        name: "folo_get_entry_contents",
        arguments: { scanId: scan.scanId, entryIds: ["entry-1"], mode: "source_page" },
      }),
    )
    expect(allowed.items[0]).toMatchObject({
      contentSource: "source_page",
      content: "Page of https://example.com/entry-1",
    })
    expect(fetchSourcePage).toHaveBeenCalledTimes(1)

    const after = payloadOf(await client.callTool({ name: "folo_get_status", arguments: {} }))
    expect(after.sourcePageEnabled).toBe(true)

    await client.close()
  })

  test("revoking the article page permission stops page reads and keeps stored reads", async () => {
    const fetchSourcePage = vi.fn(async (url: string) => ({
      ok: true as const,
      text: `Page of ${url}`,
    }))
    // The permission is already granted in the persisted setting, i.e. restored from a profile.
    const app = await started({ fetchSourcePage, sourcePageEnabled: true })
    const client = await connect(app.endpoint(), app.getToken()!)

    const scan = payloadOf(await client.callTool({ name: "folo_begin_unread_scan", arguments: {} }))
    const before = payloadOf(await client.callTool({ name: "folo_get_status", arguments: {} }))
    expect(before.sourcePageEnabled).toBe(true)

    // This is the call the settings switch makes.
    app.service.setSourcePageEnabled(false)
    expect(app.status().sourcePageEnabled).toBe(false)

    for (const args of [
      { scanId: scan.scanId, entryIds: ["entry-1"], mode: "source_page" },
      // The mode a continuation cursor carries is gated the same way as an explicit `mode`.
      { scanId: scan.scanId, cursor: "c1:source_page:0:entry-1" },
    ]) {
      const refused = await client.callTool({ name: "folo_get_entry_contents", arguments: args })
      expect(refused.isError).toBe(true)
      expect(payloadOf(refused).error.code).toBe("SOURCE_PAGE_DISABLED")
    }
    expect(fetchSourcePage).not.toHaveBeenCalled()

    // The permission only covers pages leaving the account API; stored text is still served.
    const cached = payloadOf(
      await client.callTool({
        name: "folo_get_entry_contents",
        arguments: { scanId: scan.scanId, entryIds: ["entry-1"] },
      }),
    )
    expect(cached.items[0]).toMatchObject({
      contentSource: "rss",
      content: "Text of entry-1",
      error: null,
    })

    const after = payloadOf(await client.callTool({ name: "folo_get_status", arguments: {} }))
    expect(after.sourcePageEnabled).toBe(false)

    await client.close()
  })

  test("a scan of a signed-out account is refused", async () => {
    const app = await started()
    const client = await connect(app.endpoint(), app.getToken()!)

    app.signOut()
    const answer = await client.callTool({ name: "folo_begin_unread_scan", arguments: {} })

    expect(answer.isError).toBe(true)
    expect(payloadOf(answer)).toEqual({
      error: { code: "NOT_SIGNED_IN", message: "Folo is not signed in" },
    })

    await client.close()
  })

  test("a scan does not survive an account switch", async () => {
    const app = await started()
    const client = await connect(app.endpoint(), app.getToken()!)

    const scan = payloadOf(await client.callTool({ name: "folo_begin_unread_scan", arguments: {} }))

    app.switchAccount("acct-2")
    const answer = await client.callTool({
      name: "folo_list_scan_entries",
      arguments: { scanId: scan.scanId },
    })

    expect(answer.isError).toBe(true)
    expect(payloadOf(answer).error.code).toBe("SCAN_NOT_FOUND")

    await client.close()
  })

  test("an app that has not loaded its account is not served", async () => {
    const app = await started({ ready: false })
    const client = await connect(app.endpoint(), app.getToken()!)

    const answer = await client.callTool({ name: "folo_begin_unread_scan", arguments: {} })

    expect(answer.isError).toBe(true)
    expect(payloadOf(answer).error.code).toBe("APP_NOT_READY")

    await client.close()
  })

  test("a dropped scan asks for a new scan", async () => {
    const app = await started()
    const client = await connect(app.endpoint(), app.getToken()!)

    const scan = payloadOf(await client.callTool({ name: "folo_begin_unread_scan", arguments: {} }))
    // The service drops scans when the account cannot be checked any more; keep the pointer valid
    // but invalidate the scan itself.
    app.service.invalidate("test")
    const answer = await client.callTool({
      name: "folo_list_scan_entries",
      arguments: { scanId: scan.scanId },
    })

    expect(answer.isError).toBe(true)
    expect(payloadOf(answer).error.code).toBe("SCAN_NOT_FOUND")

    await client.close()
  })
})

describe("authorization", () => {
  const post = async (
    url: string,
    options: { token?: string | null; body?: string; headers?: Record<string, string> } = {},
  ) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...options.headers,
    }
    if (options.token !== null) {
      headers.authorization = `Bearer ${options.token ?? ""}`
    }

    return fetch(url, {
      method: "POST",
      headers,
      body: options.body ?? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
  }

  test("a request without the token is refused before anything is read", async () => {
    const app = await started()
    const response = await post(app.endpoint(), { token: null })

    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toContain("Bearer")
    expect(await response.text()).not.toContain("entry")
  })

  test("a wrong token is refused", async () => {
    const app = await started()
    const response = await post(app.endpoint(), { token: createToken() })

    expect(response.status).toBe(401)
  })

  test("a revoked token stops working immediately", async () => {
    const app = await started()
    const client = await connect(app.endpoint(), app.getToken()!)
    await client.listTools()

    app.setToken(null)
    await expect(client.listTools()).rejects.toThrow()

    const response = await post(app.endpoint(), { token: createToken() })
    expect(response.status).toBe(401)

    await client.close().catch(() => {})
  })

  test("rotating the token keeps the endpoint usable with the new one only", async () => {
    const app = await started()
    const oldToken = app.getToken()!
    const rotated = app.service.rotateToken()

    expect(rotated.ok).toBe(true)
    expect(rotated.token).not.toBe(oldToken)
    expect((await post(app.endpoint(), { token: oldToken })).status).toBe(401)
    expect((await post(app.endpoint(), { token: rotated.token! })).status).not.toBe(401)
  })

  test("a hostile Host header is refused (DNS rebinding)", async () => {
    const app = await started()
    const url = new URL(app.endpoint())

    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port: Number(url.port),
          path: url.pathname,
          method: "POST",
          headers: {
            host: "attacker.example.com",
            authorization: `Bearer ${app.getToken()!}`,
            "content-type": "application/json",
          },
        },
        (response) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        },
      )
      request.on("error", reject)
      request.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }))
    })

    expect(status).toBe(403)
  })

  test("a browser request (with Origin) is refused", async () => {
    const app = await started()
    const response = await post(app.endpoint(), {
      token: app.getToken()!,
      headers: { origin: "https://evil.example.com" },
    })

    expect(response.status).toBe(403)
  })

  test("only the MCP path is answered, and only with POST", async () => {
    const app = await started()
    const endpoint = new URL(app.endpoint())

    const wrongPath = await fetch(`${endpoint.origin}/secrets`, {
      method: "POST",
      headers: { authorization: `Bearer ${app.getToken()!}`, "content-type": "application/json" },
      body: "{}",
    })
    expect(wrongPath.status).toBe(404)

    const get = await fetch(app.endpoint(), {
      headers: { authorization: `Bearer ${app.getToken()!}` },
    })
    expect(get.status).toBe(405)
  })

  test("a body that is not JSON, too large, or of the wrong type is refused", async () => {
    const app = await started({ maxRequestBodyBytes: 512 })
    const token = app.getToken()!

    const notJson = await post(app.endpoint(), { token, body: "nope" })
    expect(notJson.status).toBe(400)

    const wrongType = await fetch(app.endpoint(), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    expect(wrongType.status).toBe(415)

    const tooLarge = await post(app.endpoint(), {
      token,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        padding: "x".repeat(2_000),
      }),
    })
    expect(tooLarge.status).toBe(413)
  })

  test("requests are rate limited", async () => {
    const app = await started({ rateLimit: 3 })
    const token = app.getToken()!

    const statuses: number[] = []
    for (let index = 0; index < 4; index += 1) {
      const response = await post(app.endpoint(), { token })
      statuses.push(response.status)
    }

    expect(statuses.slice(0, 3).every((status) => status !== 429)).toBe(true)
    expect(statuses.at(-1)).toBe(429)
  })

  test("concurrent tool calls are bounded", async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })

    const app = await started({
      maxConcurrentToolCalls: 1,
      rateLimit: 100,
      resolveEntries: async (entryIds) => {
        await blocked
        return {
          ok: true,
          accountId: "acct-1",
          entries: entryIds.map((entryId) => ({
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
    })
    const client = await connect(app.endpoint(), app.getToken()!)

    const scan = payloadOf(await client.callTool({ name: "folo_begin_unread_scan", arguments: {} }))

    const slow = client.callTool({
      name: "folo_get_entry_contents",
      arguments: { scanId: scan.scanId, entryIds: ["entry-1"] },
    })
    // Give the slow call a moment to occupy the only slot.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const refused = await fetch(app.endpoint(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${app.getToken()!}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    })

    expect(refused.status).toBe(429)
    expect(refused.headers.get("retry-after")).toBeTruthy()

    release()
    const answer = payloadOf(await slow)
    expect(answer.counts.returned).toBe(1)

    await client.close()
  })
})

describe("lifecycle", () => {
  test("turning the service off closes the socket and drops the token", async () => {
    const app = await started()
    const endpoint = app.endpoint()

    const status = await app.service.setEnabled(false)
    expect(status).toMatchObject({ enabled: false, listening: false, tokenPresent: false })

    await expect(fetch(endpoint, { method: "POST", body: "{}" })).rejects.toThrow()
  })

  test("the fixed port cannot be shared, and the failure is reported", async () => {
    const first = await started({})
    // A second service on the port the first one already holds.
    const second = new LocalAgentReadingService({
      provider: {
        async describeAccount() {
          return { ok: true, accountId: "acct-1", ready: true, syncedAt: null, sources: [] }
        },
        async enumerateUnread(request) {
          return enumerationPage({ accountId: request.accountId })
        },
        async resolveEntries(request) {
          return { ok: true, accountId: request.accountId, entries: [] }
        },
      },
      resolveAccount: async () => ({
        kind: "signed-in",
        accountId: "acct-1",
        checkedAt: new Date().toISOString(),
      }),
      isEnabled: () => true,
      setEnabledFlag: () => {},
      isSourcePageEnabled: () => false,
      setSourcePageEnabledFlag: () => {},
      tokens: {
        read: () => ({ token: "token", persistence: "memory" as const }),
        issue: () => ({
          ok: true as const,
          state: { token: "token", persistence: "memory" as const },
        }),
        revoke: () => {},
      },
      port: Number(new URL(first.endpoint()).port),
    })

    await second.setEnabled(true)
    const status = second.settingsStatus()

    expect(status.listening).toBe(false)
    expect(status.listenError).toBeTruthy()
    await second.stop()
  })

  test("stopping the service refuses new connections", async () => {
    const app = await started()
    const endpoint = app.endpoint()
    const client = await connect(endpoint, app.getToken()!)

    await app.service.stop()

    await expect(client.listTools()).rejects.toThrow()
  })
})

describe("no read-state writes", () => {
  test("the tool surface and the provider expose reads only", async () => {
    const app = await started()
    const client = await connect(app.endpoint(), app.getToken()!)

    const tools = await client.listTools()
    const names = tools.tools.map((tool) => tool.name)
    // Enumerating, listing and reading are the whole surface: no mark-read, no unsubscribe.
    expect(names).toEqual([
      "folo_get_status",
      "folo_begin_unread_scan",
      "folo_list_scan_entries",
      "folo_get_entry_contents",
    ])
    for (const tool of tools.tools) {
      const schema = JSON.stringify(tool.inputSchema)
      expect(schema).not.toMatch(/mark|read:|unread:|patch|delete/i)
    }

    await client.close()
  })
})
