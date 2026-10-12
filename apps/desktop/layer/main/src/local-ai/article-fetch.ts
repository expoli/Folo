/**
 * The page fetcher of the article reader.
 *
 * A feed gives a URL, and the URL decides which machine the reader talks to. Checking the
 * destination is not enough: the check and the connection are two different moments, and a name can
 * answer with a public address for the check and a private one for the connection (DNS rebinding).
 * This fetcher therefore resolves each hop once, validates the answer, and opens the socket against
 * the validated address, while `Host` and (for https) SNI stay the article's hostname — so the
 * certificate is still verified for the host the user asked for.
 *
 * Both the resolution and the request are injectable, so the tests drive every hop (public host,
 * loopback/private/link-local/metadata answers, redirects, rebinding) without a network. Chromium's
 * network stack is deliberately not used for these requests: it cannot be told which address to
 * connect to, which is exactly what pinning needs — so the app's proxy configuration does not apply
 * to article reads (see the tech design).
 */
import type { IncomingHttpHeaders } from "node:http"
import { request as httpRequest } from "node:http"
import type { RequestOptions } from "node:https"
import { request as httpsRequest } from "node:https"

import type { HostResolver } from "./network-guard"
import { parseArticleUrl, resolvePinnedDestination } from "./network-guard"

/** Browser identification of the reader; the app sends the same one for its own page fetches. */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"

/** Redirect hops followed before the request is given up. */
export const MAX_ARTICLE_REDIRECTS = 5

export interface PageRequestInit {
  signal?: AbortSignal
  headers?: HeadersInit
}

/**
 * One page request that answers with what the server sent, *including* a redirect for the caller to
 * check and follow itself. Implementations must connect to the address they are given and must never
 * resolve the hostname again.
 */
export type PageTransport = (url: string, init: PageRequestInit) => Promise<Response>

/** One request, pinned to a validated address. */
export interface PinnedRequest {
  /** Public URL of the page; only its host, path and scheme are used. */
  url: URL
  /** Address the socket is opened against. */
  address: string
  family: 4 | 6
  headers?: HeadersInit
  signal?: AbortSignal
}

export type PinnedRequestFn = (request: PinnedRequest) => Promise<Response>

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export const isRedirectStatus = (status: number) => REDIRECT_STATUSES.has(status)

const toHeaders = (input: HeadersInit | undefined): Headers =>
  input instanceof Headers ? input : new Headers(input)

const fromIncomingHeaders = (headers: IncomingHttpHeaders): Headers => {
  const result = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    result.set(name, Array.isArray(value) ? value.join(", ") : value)
  }

  return result
}

/**
 * Requests a page from the given address, using Node's own HTTP(S) stack.
 *
 * `servername` keeps SNI and the certificate check on the article's hostname, and the `Host` header
 * is set explicitly, so a pinned connection is indistinguishable from a normal one to the server.
 * Redirects are answered to the caller instead of being followed, and every request gets its own
 * connection: a pooled socket could belong to an earlier resolution.
 */
export const nodePinnedRequest: PinnedRequestFn = ({ url, address, family, headers, signal }) =>
  new Promise<Response>((resolve, reject) => {
    const secure = url.protocol === "https:"
    const hostname = url.hostname.replace(/^\[|\]$/g, "")
    const port = url.port ? Number(url.port) : secure ? 443 : 80

    const requestHeaders: Record<string, string> = { Host: url.host }
    for (const [name, value] of toHeaders(
      headers ?? { "User-Agent": USER_AGENT, Accept: "text/html" },
    )) {
      if (name.toLowerCase() !== "host") requestHeaders[name] = value
    }

    const options: RequestOptions = {
      host: address,
      family,
      port,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: requestHeaders,
      agent: false,
      ...(secure ? { servername: hostname, rejectUnauthorized: true } : {}),
    }

    let settled = false
    const settle = (answer: () => void) => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", abort)
      answer()
    }

    const request = (secure ? httpsRequest : httpRequest)(options, (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.on("error", (error) => settle(() => reject(error)))
      response.on("end", () =>
        settle(() =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 0,
              headers: fromIncomingHeaders(response.headers),
            }),
          ),
        ),
      )
    })

    const abort = () => {
      request.destroy(new DOMException("The article request was aborted", "AbortError"))
      settle(() => reject(new DOMException("The article request was aborted", "AbortError")))
    }

    request.on("error", (error) => settle(() => reject(error)))

    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener("abort", abort, { once: true })

    request.end()
  })

export interface PinnedTransportOptions {
  /** Request primitive; the app uses Node's HTTP(S) stack, tests script their own. */
  request?: PinnedRequestFn
  /** How hostnames are resolved before a page is requested; injected by the tests. */
  resolveHostname?: HostResolver
  log?: (line: string) => void
}

/**
 * Resolves and pins one hop, then requests it. The caller gets the answer as it came, redirects
 * included, so the redirect loop can validate the next destination the same way.
 */
export const createPinnedPageTransport = (options: PinnedTransportOptions = {}): PageTransport => {
  const request = options.request ?? nodePinnedRequest

  return async (input, init) => {
    const pinned = await resolvePinnedDestination(input, {
      resolveHostname: options.resolveHostname,
      log: options.log,
    })

    return request({
      url: pinned.url,
      address: pinned.address,
      family: pinned.family,
      headers: init?.headers,
      signal: init?.signal,
    })
  }
}

export interface GuardedFetchOptions extends PinnedTransportOptions {
  /** Whole-hop transport; defaults to the pinned one built from the other options. */
  transport?: PageTransport
  maxRedirects?: number
}

/**
 * A `fetch` for the reader: only public `http(s)` destinations, every hop pinned to a validated
 * address before it is requested, and no hop left unverified.
 */
export const createGuardedArticleFetch = (
  options: GuardedFetchOptions = {},
): ((input: string, init?: RequestInit) => Promise<Response>) => {
  const transport = options.transport ?? createPinnedPageTransport(options)
  const maxRedirects = options.maxRedirects ?? MAX_ARTICLE_REDIRECTS

  return async (input, init) => {
    let url = parseArticleUrl(input)

    for (let hop = 0; ; hop += 1) {
      const response = await transport(url.href, {
        signal: init?.signal ?? undefined,
        headers: init?.headers,
      })

      const location = isRedirectStatus(response.status) ? response.headers.get("location") : null
      if (!location) return response

      if (hop >= maxRedirects) {
        throw new Error(`${input} redirected more than ${maxRedirects} times`)
      }

      // Relative `Location` headers resolve against the page that answered; the next hop is
      // validated (and pinned) by the transport of the next iteration.
      url = parseArticleUrl(new URL(location, url))
    }
  }
}
