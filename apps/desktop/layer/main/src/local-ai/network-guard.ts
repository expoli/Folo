/**
 * Destination policy of the article fetcher.
 *
 * The reader runs in the main process, so it can reach everything the machine can reach: the
 * loopback interface, the local network, and the metadata endpoints of the cloud it runs in. An
 * article URL comes from a feed and is therefore untrusted input, so only public `http(s)`
 * destinations are read, and every redirect hop is checked too.
 *
 * Checking a destination is not enough on its own: the check and the connection are two different
 * moments, and a name may answer with a public address for the check and a private one for the
 * connection (DNS rebinding). `resolvePinnedDestination` therefore returns the *address* the
 * connection has to use, and the fetcher opens the socket against that address instead of asking
 * the resolver again.
 */
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

export class BlockedDestinationError extends Error {
  readonly host: string

  constructor(host: string, reason: string) {
    super(`Blocked destination ${host}: ${reason}`)
    this.name = "BlockedDestinationError"
    this.host = host
  }
}

/** Addresses a hostname resolves to; injected so tests decide what a name answers with. */
export type HostResolver = (hostname: string) => Promise<string[]>

export const resolveHostAddresses: HostResolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true })
  return addresses.map((entry) => entry.address)
}

/** Names that are never a public article host, whatever they resolve to. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
])

/** Suffixes of the names reserved for local networks and cloud-internal services. */
const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".home.arpa",
  ".lan",
]

/** Ranges nobody publishes an article from: unspecified, private, loopback, link-local, CGNAT, … */
const BLOCKED_IPV4_RANGES: [number, number][] = [
  [0x00000000, 8], // "this network"
  [0x0a000000, 8], // 10/8
  [0x64400000, 10], // 100.64/10 (carrier NAT, includes Aliyun's 100.100.100.200)
  [0x7f000000, 8], // loopback
  [0xa9fe0000, 16], // 169.254/16 (link-local, includes 169.254.169.254)
  [0xac100000, 12], // 172.16/12
  [0xc0a80000, 16], // 192.168/16
  [0xc6120000, 15], // 198.18/15 (benchmarking)
  [0xe0000000, 4], // multicast
  [0xf0000000, 4], // reserved / broadcast
]

const BLOCKED_IPV6_RANGES: [bigint, number][] = [
  [0n, 128], // ::
  [1n, 128], // ::1
  [0xfe80n << 112n, 10], // fe80::/10 link-local
  [0xfc00n << 112n, 7], // fc00::/7 unique local
  [0xff00n << 112n, 8], // ff00::/8 multicast
]

const ipv4ToInt = (value: string): number | null => {
  const parts = value.split(".")
  if (parts.length !== 4) return null

  let result = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    result = result * 256 + octet
  }

  return result >>> 0
}

const inIpv4Range = (address: number, [network, bits]: [number, number]) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (address & mask) === (network & mask)
}

/** 16-bit groups of an IPv6 address, with a trailing dotted quad folded in. */
const ipv6Groups = (input: string): number[] | null => {
  let text = input.trim()
  const zoneIndex = text.indexOf("%")
  if (zoneIndex !== -1) text = text.slice(0, zoneIndex)

  let embedded: number[] = []
  if (text.includes(".")) {
    const lastColon = text.lastIndexOf(":")
    if (lastColon === -1) return null

    const quad = ipv4ToInt(text.slice(lastColon + 1))
    if (quad === null) return null
    embedded = [(quad >>> 16) & 0xffff, quad & 0xffff]
    text = text.slice(0, lastColon + 1)
  }

  const [head = "", ...rest] = text.split("::")
  if (rest.length > 1) return null

  const parse = (part: string) =>
    part === ""
      ? []
      : part
          .split(":")
          .map((group) =>
            /^[0-9a-f]{1,4}$/i.test(group) ? Number.parseInt(group, 16) : Number.NaN,
          )

  const headGroups = parse(head)
  const tailGroups = rest.length === 1 ? parse(rest[0]!) : []
  if ([...headGroups, ...tailGroups].some((group) => Number.isNaN(group))) return null

  const missing = 8 - embedded.length - headGroups.length - tailGroups.length
  if (missing < 0 || (rest.length === 0 && missing !== 0)) return null

  return [
    ...headGroups,
    ...Array.from({ length: rest.length === 1 ? missing : 0 }, () => 0),
    ...tailGroups,
    ...embedded,
  ]
}

const ipv6ToBigInt = (value: string): bigint | null => {
  const groups = ipv6Groups(value)
  if (!groups || groups.length !== 8) return null

  return groups.reduce((result, group) => (result << 16n) | BigInt(group), 0n)
}

/** True for addresses that are not a public destination. */
export const isBlockedAddress = (address: string): boolean => {
  const version = isIP(address)
  if (version === 4) {
    const value = ipv4ToInt(address)
    return value === null || BLOCKED_IPV4_RANGES.some((range) => inIpv4Range(value, range))
  }
  if (version !== 6) return true

  const value = ipv6ToBigInt(address)
  if (value === null) return true

  // An address that embeds an IPv4 address (::ffff:127.0.0.1) is blocked when that one is.
  if (value >> 32n === 0xffffn) {
    const mapped = Number(value & 0xffffffffn)
    if (BLOCKED_IPV4_RANGES.some((range) => inIpv4Range(mapped, range))) return true
  }

  return BLOCKED_IPV6_RANGES.some(
    ([network, bits]) => value >> BigInt(128 - bits) === network >> BigInt(128 - bits),
  )
}

/** True for names that are reserved for the local machine or a local/cloud-internal network. */
export const isBlockedHostname = (hostname: string): boolean => {
  const name = hostname.toLowerCase().replace(/\.$/, "")
  if (!name || BLOCKED_HOSTNAMES.has(name)) return true

  return BLOCKED_HOST_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

/** The URL of an article page: absolute, `http(s)` only. */
export const parseArticleUrl = (value: string | URL): URL => {
  const url = value instanceof URL ? value : new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedDestinationError(
      url.hostname,
      `only http(s) pages are read, not ${url.protocol}`,
    )
  }

  return url
}

/** A destination that passed the policy: the URL to ask for, and the address to connect to. */
export interface PinnedDestination {
  /** The public URL of the page; its host is what `Host` and (for https) SNI must carry. */
  url: URL
  /** The single address the socket is opened against. */
  address: string
  family: 4 | 6
}

/**
 * Checks the destination of one page request and returns it pinned to the address that was
 * validated, so a name that answers differently later cannot move the connection elsewhere.
 *
 * A name that cannot be resolved is refused: without an address there is nothing to pin, and
 * connecting anyway would let the request's own resolution decide — which is what a rebinding
 * attack relies on.
 */
export const resolvePinnedDestination = async (
  value: string | URL,
  options: { resolveHostname?: HostResolver; log?: (line: string) => void } = {},
): Promise<PinnedDestination> => {
  const url = parseArticleUrl(value)
  // `URL.hostname` keeps the brackets of an IPv6 literal.
  const hostname = url.hostname.replace(/^\[|\]$/g, "")

  if (isBlockedHostname(hostname)) {
    throw new BlockedDestinationError(hostname, "not a public host")
  }

  const literalFamily = isIP(hostname)
  if (literalFamily) {
    if (isBlockedAddress(hostname)) {
      throw new BlockedDestinationError(hostname, "not a public address")
    }

    return { url, address: hostname, family: literalFamily === 6 ? 6 : 4 }
  }

  let addresses: string[]
  try {
    addresses = await (options.resolveHostname ?? resolveHostAddresses)(hostname)
  } catch (error) {
    throw new BlockedDestinationError(
      hostname,
      `cannot be resolved locally (${error instanceof Error ? error.message : String(error)})`,
    )
  }

  const blocked = addresses.find((address) => isBlockedAddress(address))
  if (blocked) {
    throw new BlockedDestinationError(hostname, `${hostname} resolves to ${blocked}`)
  }

  const [address] = addresses
  if (!address) {
    throw new BlockedDestinationError(hostname, "has no address")
  }

  return { url, address, family: isIP(address) === 6 ? 6 : 4 }
}
