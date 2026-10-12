import type { IncomingMessage, ServerResponse } from "node:http"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import { describe, expect, test, vi } from "vitest"

import type { PinnedRequest } from "./article-fetch"
import {
  createGuardedArticleFetch,
  isRedirectStatus,
  MAX_ARTICLE_REDIRECTS,
  nodePinnedRequest,
} from "./article-fetch"

const page = (body: string, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/html" } })

const redirectTo = (location: string) =>
  new Response(null, { status: 302, headers: { Location: location } })

describe("createGuardedArticleFetch", () => {
  test("pins every hop, follows redirects itself and keeps the article's host", async () => {
    const request = vi.fn(async ({ url }: PinnedRequest) =>
      url.pathname === "/article" ? redirectTo("/moved") : page("<p>final</p>"),
    )
    const fetchPage = createGuardedArticleFetch({
      resolveHostname: async () => ["93.184.216.34"],
      request,
    })

    const response = await fetchPage("https://public.example.com/article", {
      headers: { Accept: "text/html" },
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("<p>final</p>")
    expect(request).toHaveBeenCalledTimes(2)
    // The hop the server asked for, still on the public host and still pinned to the validated
    // address — the transport never resolves a name itself.
    expect(String(request.mock.calls[1]![0].url)).toBe("https://public.example.com/moved")
    expect(request.mock.calls[1]![0]).toMatchObject({ address: "93.184.216.34", family: 4 })
    // The reader's own headers travel to the transport unchanged.
    expect(request.mock.calls[0]![0].headers).toMatchObject({ Accept: "text/html" })
  })

  test("refuses a redirect into the private network without requesting it", async () => {
    const request = vi.fn(async (_request: PinnedRequest) =>
      redirectTo("http://169.254.169.254/latest/meta-data/"),
    )
    const fetchPage = createGuardedArticleFetch({
      resolveHostname: async () => ["93.184.216.34"],
      request,
    })

    await expect(fetchPage("https://public.example.com/article")).rejects.toThrow(
      /not a public address/,
    )
    // The metadata request was never issued: the destination is refused before the socket opens.
    expect(request).toHaveBeenCalledTimes(1)
  })

  test("refuses a destination that only becomes private on a redirect", async () => {
    const request = vi.fn(async (_request: PinnedRequest) =>
      redirectTo("https://intranet.example.com/internal/secret"),
    )
    const fetchPage = createGuardedArticleFetch({
      resolveHostname: async (hostname: string) =>
        hostname === "public.example.com" ? ["93.184.216.34"] : ["10.1.2.3"],
      request,
    })

    await expect(fetchPage("https://public.example.com/article")).rejects.toThrow(
      /resolves to 10\.1\.2\.3/,
    )
    expect(request).toHaveBeenCalledTimes(1)
  })

  test("connects to the address it validated even when the name answers differently afterwards", async () => {
    // The second answer of a rebinding name: it must never be the one the connection uses.
    const answers = [["93.184.216.34"], ["127.0.0.1"]]
    const resolveHostname = vi.fn(async () => answers.shift() ?? ["127.0.0.1"])
    const request = vi.fn(async (_request: PinnedRequest) => page("<p>public</p>"))

    const fetchPage = createGuardedArticleFetch({ resolveHostname, request })
    await expect(fetchPage("https://rebind.example.com/article")).resolves.toMatchObject({
      status: 200,
    })

    expect(resolveHostname).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]![0].address).toBe("93.184.216.34")
  })

  test("gives up once a redirect chain is longer than allowed", async () => {
    const request = vi.fn(async ({ url }: PinnedRequest) => redirectTo(`${url.pathname}/again`))
    const fetchPage = createGuardedArticleFetch({
      resolveHostname: async () => ["93.184.216.34"],
      request,
      maxRedirects: 2,
    })

    await expect(fetchPage("https://public.example.com/a")).rejects.toThrow(
      /redirected more than 2 times/,
    )
    expect(request).toHaveBeenCalledTimes(3)
    expect(MAX_ARTICLE_REDIRECTS).toBe(5)
  })

  test("refuses a non-http scheme before any request", async () => {
    const request = vi.fn(async (_request: PinnedRequest) => page("x"))
    const fetchPage = createGuardedArticleFetch({ request })

    await expect(fetchPage("file:///etc/hosts")).rejects.toThrow(/only http\(s\)/)
    expect(request).not.toHaveBeenCalled()
  })

  test("answers a redirect status as a redirect", () => {
    expect([301, 302, 303, 307, 308].every((status) => isRedirectStatus(status))).toBe(true)
    expect(isRedirectStatus(200)).toBe(false)
  })
})

describe("nodePinnedRequest", () => {
  const withServer = async (
    handler: (req: IncomingMessage, res: ServerResponse) => void,
    run: (port: number, seen: { host?: string; url?: string }) => Promise<void>,
  ) => {
    const seen: { host?: string; url?: string } = {}
    const server = createServer((req, res) => {
      seen.host = req.headers.host
      seen.url = req.url
      handler(req, res)
    })

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address() as AddressInfo

    try {
      await run(port, seen)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  test("opens the socket on the pinned address and asks for the article's host", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(302, {
          Location: "https://elsewhere.example.com/",
          "Content-Type": "text/html",
        })
        res.end("redirecting")
      },
      async (port, seen) => {
        const response = await nodePinnedRequest({
          // The connection is pinned to 127.0.0.1 while the request still asks for the article.
          url: new URL(`http://article.example.com:${port}/path?x=1`),
          address: "127.0.0.1",
          family: 4,
        })

        expect(seen.host).toBe(`article.example.com:${port}`)
        expect(seen.url).toBe("/path?x=1")
        // Redirects are the caller's to validate, so they come back as answers.
        expect(response.status).toBe(302)
        expect(response.headers.get("location")).toBe("https://elsewhere.example.com/")
      },
    )
  })

  test("aborts the socket when the request is cancelled", async () => {
    await withServer(
      () => {
        // Never answers: the reader gave up (timeout, closed window) while the page was loading.
      },
      async (port) => {
        const controller = new AbortController()
        const pending = nodePinnedRequest({
          url: new URL(`http://article.example.com:${port}/slow`),
          address: "127.0.0.1",
          family: 4,
          signal: controller.signal,
        })

        controller.abort()

        await expect(pending).rejects.toThrow(/aborted/)
      },
    )
  })
})
