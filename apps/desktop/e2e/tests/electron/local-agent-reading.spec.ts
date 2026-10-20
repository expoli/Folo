/**
 * The loopback MCP endpoint of the local agent reading feature, driven as an external agent would.
 *
 * The test owns its profile (no user data is read or written), and it speaks the real protocol: the
 * official MCP client connects over 127.0.0.1 with the token the app minted, lists the tools, calls
 * them, and the guards are probed with raw HTTP. The app is *not* signed in — a fresh profile has no
 * session, and the test must not borrow one — so this covers everything except reading a real
 * account's entries, which stays an open acceptance gate. The refusals are asserted to be honest
 * refusals (a named error), never an empty scan that would read as "no unread articles". The
 * article page permission is checked as a setting main enforces: off for a fresh profile, a
 * separate switch from the endpoint, and reported to the agent unchanged.
 */
import { request as httpRequest } from "node:http"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Page } from "@playwright/test"
import { expect, test } from "@playwright/test"

import { closeElectronApp, launchElectronApp } from "../../support/electron"
import { resolveDesktopE2EEnv } from "../../support/env"

const ENDPOINT = "http://127.0.0.1:41610/mcp"
const ENDPOINT_PORT = 41610

/** The four read methods, and nothing that could change what the user has read. */
const READ_ONLY_BRIDGE_METHODS = [
  "localAgentReadingCancel",
  "localAgentReadingDescribeAccount",
  "localAgentReadingEnumerateUnread",
  "localAgentReadingResolveEntries",
].sort()

const READ_ONLY_TOOLS = [
  "folo_begin_unread_scan",
  "folo_get_entry_contents",
  "folo_get_status",
  "folo_list_scan_entries",
].sort()

interface ElectronBridge {
  electron?: { ipcRenderer: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } }
}

/** Calls the settings IPC exactly as the Integration tab's switch and buttons do. */
const invoke = <T>(page: Page, channel: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(
    (payload) =>
      (globalThis as unknown as ElectronBridge).electron!.ipcRenderer.invoke(
        payload.channel,
        ...payload.args,
      ),
    { channel, args },
  ) as Promise<T>

const initializeRequest = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  })

/** `fetch` cannot set `Host`, so a hostile one goes through node:http. */
const postWithHost = (host: string, token: string) =>
  new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: ENDPOINT_PORT,
        path: "/mcp",
        method: "POST",
        headers: {
          host,
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
      },
      (response) => {
        response.resume()
        response.on("end", () => resolve(response.statusCode ?? 0))
      },
    )
    request.on("error", reject)
    request.end(JSON.stringify(initializeRequest))
  })

interface ToolTextResult {
  isError?: boolean
  content?: { type: string; text?: string }[]
}

const payloadOf = (result: ToolTextResult) => JSON.parse(result.content?.[0]?.text ?? "null")

const connectClient = async (token: string) => {
  const client = new Client({ name: "folo-local-agent-reading-e2e", version: "0.0.0" })
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return client
}

test.describe("local agent reading endpoint", () => {
  test("serves read-only tools over loopback to an authenticated agent only", async () => {
    test.setTimeout(300_000)

    const env = resolveDesktopE2EEnv()
    const app = await launchElectronApp(env)
    const { page } = app
    let client: Client | null = null

    try {
      await test.step("starts with the switch off and no token", async () => {
        // The preload bridge is available once the window's preload has run.
        await page.waitForFunction(
          () => Boolean((globalThis as unknown as ElectronBridge).electron?.ipcRenderer),
          undefined,
          { timeout: 60_000 },
        )

        const status = await invoke<{
          enabled: boolean
          sourcePageEnabled: boolean
          listening: boolean
          endpoint: string | null
          tokenPresent: boolean
        }>(page, "localAgentReading.getStatus")

        expect(status.enabled).toBe(false)
        // Article page fetching is a second, separate permission and is off for a fresh profile.
        expect(status.sourcePageEnabled).toBe(false)
        expect(status.listening).toBe(false)
        expect(status.endpoint).toBeNull()
        expect(status.tokenPresent).toBe(false)
        // Nothing is reachable while the switch is off.
        const refused = await fetch(ENDPOINT, { method: "POST" }).catch(() => null)
        expect(refused).toBeNull()
      })

      await test.step("publishes exactly the four read-only bridge methods", async () => {
        // The provider registers on mount, which is after the renderer bundle has loaded.
        await page.waitForFunction(
          () =>
            typeof (globalThis as unknown as { __follow?: { localAgentReadingCancel?: unknown } })
              .__follow?.localAgentReadingCancel === "function",
          undefined,
          { timeout: 120_000 },
        )

        // A user can only read; the renderer must not even expose a method that marks entries.
        const registered = await page.evaluate(() =>
          Object.keys((globalThis as unknown as { __follow: Record<string, unknown> }).__follow)
            .filter((key) => key.startsWith("localAgentReading"))
            .sort(),
        )
        expect(registered).toEqual(READ_ONLY_BRIDGE_METHODS)
      })

      let token = ""

      await test.step("turning the switch on listens on the fixed loopback endpoint and mints a token", async () => {
        const status = await invoke<{
          listening: boolean
          endpoint: string | null
          tokenPresent: boolean
          listenError: string | null
        }>(page, "localAgentReading.setEnabled", { enabled: true })

        expect(status.listening).toBe(true)
        expect(status.endpoint).toBe(ENDPOINT)
        expect(status.tokenPresent).toBe(true)
        expect(status.listenError).toBeNull()

        const revealed = await invoke<{ ok: boolean; token: string | null; persistence: string }>(
          page,
          "localAgentReading.revealToken",
        )
        expect(revealed.ok).toBe(true)
        // The token is memory-only here (no OS keyring in the test environment); that is reported,
        // not hidden, so the settings section can warn about it.
        expect(["memory", "os-keyring"]).toContain(revealed.persistence)
        expect(typeof revealed.token).toBe("string")
        token = revealed.token as string
      })

      await test.step("the settings UI is the documented enable path and is gated behind sign-in", async () => {
        // The Integration tab refuses to render while signed out, which is why this test drives the
        // same IPC methods its switch and reveal buttons call. Recorded so the UI gate stays visible.
        await page.evaluate(() =>
          (
            globalThis as unknown as { router?: { showSettings?: (options: unknown) => void } }
          ).router?.showSettings?.({ tab: "integration" }),
        )
        const settings = page.locator("#setting-modal").first()
        await expect(settings).toBeVisible({ timeout: 15_000 })
        await expect(settings).toContainText(/请登录后访问此设置|sign in to access this setting/, {
          timeout: 15_000,
        })
        await page.keyboard.press("Escape")
      })

      await test.step("the article page permission is a separate switch and stays off until asked for", async () => {
        const allowed = await invoke<{
          enabled: boolean
          sourcePageEnabled: boolean
          listening: boolean
        }>(page, "localAgentReading.setSourcePageEnabled", { enabled: true })

        // Granting the page permission must not disturb the endpoint switch or the socket.
        expect(allowed.sourcePageEnabled).toBe(true)
        expect(allowed.enabled).toBe(true)
        expect(allowed.listening).toBe(true)

        const offAgain = await invoke<{ sourcePageEnabled: boolean; listening: boolean }>(
          page,
          "localAgentReading.setSourcePageEnabled",
          { enabled: false },
        )
        expect(offAgain.sourcePageEnabled).toBe(false)
        expect(offAgain.listening).toBe(true)
      })

      await test.step("refuses requests without a token, from a browser origin, or with a foreign Host", async () => {
        const anonymous = await post(initializeRequest)
        expect(anonymous.status).toBe(401)
        expect(anonymous.headers.get("www-authenticate")).toBeTruthy()
        // The refusal says nothing about the account, the switch, or the token.
        expect(await anonymous.text()).not.toContain(token)

        const wrongToken = await post(initializeRequest, {
          authorization: "Bearer not-the-token",
        })
        expect(wrongToken.status).toBe(401)

        const fromBrowser = await post(initializeRequest, {
          authorization: `Bearer ${token}`,
          origin: "https://evil.example",
        })
        expect(fromBrowser.status).toBe(403)

        expect(await postWithHost("evil.example", token)).toBe(403)
      })

      await test.step("an MCP client sees four read-only tools and an honest status", async () => {
        client = await connectClient(token)

        const { tools } = await client.listTools()
        expect(tools.map((tool) => tool.name).sort()).toEqual(READ_ONLY_TOOLS)
        for (const tool of tools) {
          expect(tool.annotations?.readOnlyHint).toBe(true)
          expect(tool.annotations?.destructiveHint).toBe(false)
        }
        // There is deliberately no tool that marks anything read.
        expect(tools.some((tool) => /mark|unread_count|read_state/i.test(tool.name))).toBe(false)

        // No tool takes a URL to fetch (source pages come from the entry itself) and no tool takes
        // a read state to write.
        const argumentNames = tools.flatMap((tool) =>
          Object.keys((tool.inputSchema?.properties as Record<string, unknown> | undefined) ?? {}),
        )
        expect(argumentNames).not.toContain("url")
        expect(argumentNames).not.toContain("read")
        expect(argumentNames).not.toContain("readState")
        // No tool can grant itself the permission to leave the account API.
        expect(argumentNames).not.toContain("sourcePageEnabled")

        const status = payloadOf(
          (await client.callTool({ name: "folo_get_status", arguments: {} })) as ToolTextResult,
        )
        expect(status.service).toBe("folo-local-agent-reading")
        expect(status.enabled).toBe(true)
        expect(status.account).toBeNull()
        // Signed out and "could not be checked" stay apart; neither is reported as signed in.
        expect([false, "unknown"]).toContain(status.signedIn)
        expect(status.ready).toBe(false)
        // The agent sees the article page permission as the settings left it: off.
        expect(status.sourcePageEnabled).toBe(false)
        expect(status.sources).toEqual([])
        // No credential travels to the agent.
        expect(JSON.stringify(status)).not.toContain(token)
        expect(JSON.stringify(status).toLowerCase()).not.toContain("cookie")
      })

      await test.step("the agent-facing status follows the page permission set by the settings window", async () => {
        await invoke(page, "localAgentReading.setSourcePageEnabled", { enabled: true })
        const granted = payloadOf(
          (await client!.callTool({ name: "folo_get_status", arguments: {} })) as ToolTextResult,
        )
        expect(granted.sourcePageEnabled).toBe(true)

        const off = await invoke<{ sourcePageEnabled: boolean; listening: boolean }>(
          page,
          "localAgentReading.setSourcePageEnabled",
          { enabled: false },
        )
        expect(off.sourcePageEnabled).toBe(false)
        expect(off.listening).toBe(true)

        const revoked = payloadOf(
          (await client!.callTool({ name: "folo_get_status", arguments: {} })) as ToolTextResult,
        )
        expect(revoked.sourcePageEnabled).toBe(false)
        // The endpoint is still serving: only the page permission changed.
        expect(revoked.enabled).toBe(true)
      })

      await test.step("no scan is invented when the account cannot be read", async () => {
        const scan = (await client!.callTool({
          name: "folo_begin_unread_scan",
          arguments: {},
        })) as ToolTextResult

        expect(scan.isError).toBe(true)
        const refusal = payloadOf(scan)
        // An unreadable account is a named refusal, never an empty candidate list that would read
        // as "you have no unread articles".
        expect(["NOT_SIGNED_IN", "ACCOUNT_UNAVAILABLE"]).toContain(refusal.error.code)
        expect(JSON.stringify(refusal).toLowerCase()).not.toContain("cookie")
        expect(JSON.stringify(refusal)).not.toContain(token)

        for (const [name, args] of [
          ["folo_list_scan_entries", { scanId: "not-a-scan" }],
          ["folo_get_entry_contents", { scanId: "not-a-scan", entryIds: ["entry-1"] }],
        ] as const) {
          const answer = (await client!.callTool({ name, arguments: args })) as ToolTextResult
          expect(answer.isError).toBe(true)
          expect(["SCAN_NOT_FOUND", "NOT_SIGNED_IN", "ACCOUNT_UNAVAILABLE"]).toContain(
            payloadOf(answer).error.code,
          )
        }
      })

      await test.step("rotating the token invalidates the old one", async () => {
        const rotated = await invoke<{ ok: boolean; token: string | null }>(
          page,
          "localAgentReading.rotateToken",
        )
        expect(rotated.ok).toBe(true)
        expect(rotated.token).not.toBe(token)

        await client!.close()
        client = null

        const withOldToken = await post(initializeRequest, {
          authorization: `Bearer ${token}`,
        })
        expect(withOldToken.status).toBe(401)

        client = await connectClient(rotated.token as string)
        expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(
          READ_ONLY_TOOLS,
        )
        await client.close()
        client = null
      })

      await test.step("revoking keeps the socket up but refuses every request", async () => {
        const revoked = await invoke<{ ok: boolean; token: string | null }>(
          page,
          "localAgentReading.revokeToken",
        )
        expect(revoked.ok).toBe(true)
        expect(revoked.token).toBeNull()

        const status = await invoke<{ listening: boolean; tokenPresent: boolean }>(
          page,
          "localAgentReading.getStatus",
        )
        expect(status.tokenPresent).toBe(false)
        expect(status.listening).toBe(true)

        const refused = await post(initializeRequest)
        expect(refused.status).toBe(401)
      })

      await test.step("switching off closes the socket", async () => {
        const status = await invoke<{ listening: boolean; endpoint: string | null }>(
          page,
          "localAgentReading.setEnabled",
          { enabled: false },
        )
        expect(status.listening).toBe(false)
        expect(status.endpoint).toBeNull()

        const unreachable = await fetch(ENDPOINT, { method: "POST" }).catch(() => null)
        expect(unreachable).toBeNull()
      })
    } finally {
      await client?.close().catch(() => {})
      await closeElectronApp(app)
    }
  })
})
