/**
 * Checks the packaged desktop build, not the development build.
 *
 * The MCP endpoint lives in the main process and its tools are bundled into `app.asar`, so the only
 * way to know the shipped artifact exposes them is to start the artifact itself. This script starts
 * an extracted AppImage twice with a throwaway profile (`FOLO_E2E_USER_DATA_DIR`, so the real user
 * data of the machine is never touched): the first run turns the endpoint on and exercises the
 * guards and tools, the second proves the switch, the endpoint and the token survive a restart.
 *
 *   node apps/desktop/e2e/scripts/check-packaged-local-agent-reading.mjs \
 *     apps/desktop/out/verify/appimage/squashfs-root
 *
 * It verifies the transport, the tool surface, the guards, the refusals and the restart path. It
 * cannot verify reading a real account: the throwaway profile is signed out by construction, so the
 * scan is expected to be refused with a named error rather than to return entries.
 */
import { spawn } from "node:child_process"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { chromium } from "playwright"

const ENDPOINT = "http://127.0.0.1:41610/mcp"
const CDP_PORT = Number(process.env.FOLO_PACKAGED_CDP_PORT ?? 9333)
const READ_ONLY_TOOLS = [
  "folo_begin_unread_scan",
  "folo_get_entry_contents",
  "folo_get_status",
  "folo_list_scan_entries",
]

const failures = []
const check = (condition, label) => {
  console.log(`  ${condition ? "ok      " : "FAILED  "} ${label}`)
  if (!condition) failures.push(label)
}
const fail = (label) => check(false, label)

const initializeRequest = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }

const appDir = resolve(process.argv[2] ?? "apps/desktop/out/verify/appimage/squashfs-root")
const binary = join(appDir, "Folo")

const waitForCdp = async () => {
  for (let attempt = 0; attempt < 120; attempt++) {
    const reachable = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      .then((response) => response.ok)
      .catch(() => false)
    if (reachable) return true
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  }
  return false
}

const startApp = async (userDataDir) => {
  const child = spawn(binary, ["--no-sandbox", `--remote-debugging-port=${CDP_PORT}`], {
    cwd: appDir,
    env: { ...process.env, FOLO_E2E_USER_DATA_DIR: userDataDir, NODE_ENV: "production" },
    stdio: ["ignore", "ignore", "ignore"],
  })

  let browser
  try {
    if (!(await waitForCdp())) return { child, error: "the packaged app opened a debugging port" }

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`)
    const context = browser.contexts()[0]
    let page = context.pages().find((candidate) => candidate.url().startsWith("app://"))
    for (let attempt = 0; attempt < 60 && !page; attempt++) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 500))
      page = context.pages().find((candidate) => candidate.url().startsWith("app://"))
    }
    if (!page) return { child, browser, error: "the packaged app loaded its renderer" }

    await page.waitForFunction(() => Boolean(globalThis.electron?.ipcRenderer), undefined, {
      timeout: 60_000,
    })
    // The bridge is registered when the renderer mounts its providers, not when the preload runs.
    await page
      .waitForFunction(
        () => typeof globalThis.__follow?.localAgentReadingCancel === "function",
        undefined,
        {
          timeout: 120_000,
        },
      )
      .catch(() => {})

    const invoke = (channel, ...args) =>
      page.evaluate(
        (payload) => globalThis.electron.ipcRenderer.invoke(payload.channel, ...payload.args),
        { channel, args },
      )

    return { child, browser, page, invoke }
  } catch (error) {
    return { child, browser, error: String(error) }
  }
}

const stopApp = async (app) => {
  await app.browser?.close().catch(() => {})
  app.child.kill("SIGTERM")
  await new Promise((resolveWait) => setTimeout(resolveWait, 3000))
  app.child.kill("SIGKILL")
}

const main = async () => {
  await stat(binary)
  const userDataDir = await mkdtemp(join(tmpdir(), "folo-packaged-check-"))

  try {
    // ---------------------------------------------------------------- first run: off by default
    const first = await startApp(userDataDir)
    if (first.error) {
      fail(first.error)
      await stopApp(first)
      return
    }

    const registered = await first.page.evaluate(() =>
      Object.keys(globalThis.__follow ?? {})
        .filter((key) => key.startsWith("localAgentReading"))
        .sort(),
    )
    check(
      registered.length === 4 &&
        registered.includes("localAgentReadingEnumerateUnread") &&
        registered.includes("localAgentReadingResolveEntries"),
      "the renderer registered the reading bridge",
    )

    const initial = await first.invoke("localAgentReading.getStatus")
    check(
      initial.enabled === false && initial.listening === false,
      "the endpoint starts switched off",
    )
    check(initial.tokenPresent === false, "no token exists before the feature is enabled")
    check(initial.sourcePageEnabled === false, "article page fetching starts switched off")

    const enabled = await first.invoke("localAgentReading.setEnabled", { enabled: true })
    check(enabled.listening === true, "the packaged app listens on the loopback endpoint")
    check(enabled.endpoint === ENDPOINT, `the endpoint is ${ENDPOINT}`)

    const revealed = await first.invoke("localAgentReading.revealToken")
    const token = revealed?.token
    check(typeof token === "string" && token.length > 20, "a dedicated token was minted")

    const anonymous = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(initializeRequest),
    })
    check(anonymous.status === 401, "a request without the token is refused with 401")

    const wrongToken = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify(initializeRequest),
    })
    check(wrongToken.status === 401, "a request with a wrong token is refused with 401")

    const fromBrowser = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        origin: "https://evil.example",
      },
      body: JSON.stringify(initializeRequest),
    })
    check(fromBrowser.status === 403, "a request carrying an Origin header is refused with 403")

    let client = new Client({ name: "folo-packaged-check", version: "0.0.0" })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(ENDPOINT), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    )

    const { tools } = await client.listTools()
    check(
      JSON.stringify(tools.map((tool) => tool.name).sort()) === JSON.stringify(READ_ONLY_TOOLS),
      "the agent sees exactly the four read-only tools",
    )
    check(
      tools.every((tool) => tool.annotations?.readOnlyHint === true),
      "every tool is annotated read-only",
    )
    const argumentNames = tools.flatMap((tool) => Object.keys(tool.inputSchema?.properties ?? {}))
    check(
      !argumentNames.includes("url") &&
        !argumentNames.includes("read") &&
        !argumentNames.includes("readState"),
      "no tool accepts a URL to fetch or a read state to write",
    )

    const status = JSON.parse(
      (await client.callTool({ name: "folo_get_status", arguments: {} })).content[0].text,
    )
    check(status.service === "folo-local-agent-reading", "folo_get_status answers")
    check(status.sourcePageEnabled === false, "the agent is told that article page fetching is off")
    check(
      ["false", "unknown"].includes(JSON.stringify(status.signedIn)),
      "the throwaway profile is reported as not signed in",
    )
    check(!JSON.stringify(status).includes(token), "the token never appears in a tool answer")

    const scan = await client.callTool({ name: "folo_begin_unread_scan", arguments: {} })
    check(scan.isError === true, "a scan without an account is refused instead of invented")

    // The article page permission is a separate setting, default off, changed only through the
    // settings IPC (no tool accepts it) and reported to the agent.
    const granted = await first.invoke("localAgentReading.setSourcePageEnabled", { enabled: true })
    check(
      granted.sourcePageEnabled === true,
      "the page permission is granted through the settings IPC",
    )
    check(
      granted.enabled === true && granted.listening === true,
      "granting the page permission leaves the endpoint switch and socket alone",
    )
    const statusAfterGrant = JSON.parse(
      (await client.callTool({ name: "folo_get_status", arguments: {} })).content[0].text,
    )
    check(statusAfterGrant.sourcePageEnabled === true, "the agent sees the granted page permission")

    const rotated = await first.invoke("localAgentReading.rotateToken")
    check(rotated.ok === true && rotated.token !== token, "rotating mints a different token")
    const stale = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(initializeRequest),
    })
    check(stale.status === 401, "the rotated token no longer works")
    await client.close()
    client = undefined

    await stopApp(first)

    // --------------------------------------------------- second run: switch, endpoint and token
    const second = await startApp(userDataDir)
    if (second.error) {
      fail(second.error)
      await stopApp(second)
      return
    }

    const restarted = await second.invoke("localAgentReading.getStatus")
    check(restarted.enabled === true, "the switch survived the restart")
    check(restarted.listening === true, "the endpoint came back up on its own")
    check(restarted.tokenPresent === true, "the token was restored, not re-minted")
    check(restarted.sourcePageEnabled === true, "the article page permission survived the restart")
    const restored = await second.invoke("localAgentReading.revealToken")
    check(restored.token === rotated.token, "the revealed token is the one that was minted")

    client = new Client({ name: "folo-packaged-check-2", version: "0.0.0" })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(ENDPOINT), {
        requestInit: { headers: { Authorization: `Bearer ${restored.token}` } },
      }),
    )
    check(
      JSON.stringify((await client.listTools()).tools.map((tool) => tool.name).sort()) ===
        JSON.stringify(READ_ONLY_TOOLS),
      "the restored endpoint serves the same tools",
    )
    const restoredStatus = JSON.parse(
      (await client.callTool({ name: "folo_get_status", arguments: {} })).content[0].text,
    )
    check(
      restoredStatus.sourcePageEnabled === true,
      "the restored endpoint reports the persisted page permission",
    )
    await client.close()
    client = undefined

    const disabled = await second.invoke("localAgentReading.setEnabled", { enabled: false })
    check(disabled.listening === false, "switching the endpoint off closes the socket")
    check(disabled.tokenPresent === false, "switching off revokes the token")
    check(
      disabled.sourcePageEnabled === true,
      "switching the endpoint off does not silently revoke the page permission",
    )

    await stopApp(second)
  } finally {
    await rm(userDataDir, { force: true, recursive: true })
  }
}

await main()
if (failures.length > 0) {
  console.log(`\nRESULT: ${failures.length} check(s) failed`)
  process.exit(1)
}
console.log("\nRESULT: packaged artifact serves the reading endpoint")
