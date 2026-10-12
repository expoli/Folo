import { describe, expect, test, vi } from "vitest"

import {
  BlockedDestinationError,
  isBlockedAddress,
  isBlockedHostname,
  parseArticleUrl,
  resolvePinnedDestination,
} from "./network-guard"

describe("isBlockedAddress", () => {
  test.each([
    "0.0.0.0",
    "127.0.0.1",
    "127.9.9.9",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "169.254.0.1",
    "100.64.0.1",
    "100.100.100.200",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
  ])("refuses %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true)
  })

  test.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "192.169.0.1", "100.63.255.255"])(
    "accepts %s",
    (address) => {
      expect(isBlockedAddress(address)).toBe(false)
    },
  )

  test("covers the IPv6 forms of the same ranges", () => {
    for (const address of [
      "::",
      "::1",
      "fe80::1",
      "fc00::1",
      "fd00::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:169.254.169.254",
    ]) {
      expect({ address, blocked: isBlockedAddress(address) }).toEqual({ address, blocked: true })
    }

    for (const address of ["2606:4700:4700::1111", "2001:4860:4860::8888"]) {
      expect({ address, blocked: isBlockedAddress(address) }).toEqual({ address, blocked: false })
    }
  })

  test("refuses what is not an address at all", () => {
    expect(isBlockedAddress("not-an-address")).toBe(true)
    expect(isBlockedAddress("")).toBe(true)
  })
})

describe("isBlockedHostname", () => {
  test.each([
    "localhost",
    "localhost.",
    "LOCALHOST",
    "metadata",
    "metadata.google.internal",
    "instance-data",
    "printer.local",
    "api.internal",
    "router.lan",
    "box.home.arpa",
  ])("refuses %s", (hostname) => {
    expect(isBlockedHostname(hostname)).toBe(true)
  })

  test.each([
    "example.com",
    "news.example.com",
    "localhost.example.com",
    "notinternal.example.com",
  ])("accepts %s", (hostname) => {
    expect(isBlockedHostname(hostname)).toBe(false)
  })
})

describe("parseArticleUrl", () => {
  test("reads http(s) pages", () => {
    expect(parseArticleUrl("https://example.com/a").hostname).toBe("example.com")
    expect(parseArticleUrl("http://example.com/a").protocol).toBe("http:")
  })

  test("refuses another scheme", () => {
    expect(() => parseArticleUrl("file:///etc/passwd")).toThrow(BlockedDestinationError)
    expect(() => parseArticleUrl("ftp://example.com/a")).toThrow(/only http\(s\)/)
  })
})

describe("resolvePinnedDestination", () => {
  test("pins a public name to the address it resolved to, once", async () => {
    const resolveHostname = vi.fn(async () => ["93.184.216.34"])
    const pinned = await resolvePinnedDestination("https://example.com/article?a=1", {
      resolveHostname,
    })

    expect(pinned).toMatchObject({ address: "93.184.216.34", family: 4 })
    // The URL the request has to ask for keeps the public host (`Host`/SNI come from it).
    expect(pinned.url.href).toBe("https://example.com/article?a=1")
    expect(resolveHostname).toHaveBeenCalledTimes(1)
  })

  test("keeps the family of an IPv6 answer", async () => {
    await expect(
      resolvePinnedDestination("https://example.com/", {
        resolveHostname: async () => ["2606:4700:4700::1111"],
      }),
    ).resolves.toMatchObject({ address: "2606:4700:4700::1111", family: 6 })
  })

  test("refuses a name that answers with a private address", async () => {
    await expect(
      resolvePinnedDestination("https://intranet.example.com/", {
        resolveHostname: async () => ["10.0.0.7"],
      }),
    ).rejects.toThrow(/resolves to 10\.0\.0\.7/)
  })

  test("refuses a name that resolves to both a public and a private address", async () => {
    await expect(
      resolvePinnedDestination("https://mixed.example.com/", {
        resolveHostname: async () => ["93.184.216.34", "127.0.0.1"],
      }),
    ).rejects.toThrow(BlockedDestinationError)
  })

  test("refuses a name it cannot resolve, instead of letting the request decide", async () => {
    await expect(
      resolvePinnedDestination("https://gone.example.com/", {
        resolveHostname: async () => {
          throw new Error("ENOTFOUND")
        },
      }),
    ).rejects.toThrow(/cannot be resolved locally/)
  })

  test("refuses a blocked literal without resolving anything", async () => {
    const resolveHostname = vi.fn(async () => ["93.184.216.34"])

    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1:8080/",
      "http://[::1]/",
      "http://metadata.google.internal/computeMetadata/v1/",
    ]) {
      await expect(resolvePinnedDestination(url, { resolveHostname })).rejects.toThrow(
        BlockedDestinationError,
      )
    }

    expect(resolveHostname).not.toHaveBeenCalled()
  })
})
