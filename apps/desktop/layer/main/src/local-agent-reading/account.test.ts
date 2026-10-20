import { FollowAPIError } from "@follow-app/client-sdk"
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getSession: async (): Promise<{ user?: { id?: string } } | null> => null,
}))

vi.mock("../lib/api-client", () => ({
  apiClient: {
    auth: {
      getSession: () => mocks.getSession(),
    },
  },
}))

const { resolveSessionAccount } = await import("./account")

/** The account client's real message: it carries the request headers, cookie included. */
const apiError = (status: number) =>
  new FollowAPIError(
    `Request failed\nRequest: GET /better-auth/get-session\nArgs: {\n  "headers": {\n    "Cookie": "better-auth.session_token=secret-session-token"\n  }\n}`,
    status,
  )

beforeEach(() => {
  mocks.getSession = async () => null
})

describe("resolveSessionAccount", () => {
  test("names the account the session API returns", async () => {
    mocks.getSession = async () => ({ user: { id: "user-1" } })

    const resolution = await resolveSessionAccount()

    expect(resolution.kind).toBe("signed-in")
    expect(resolution.kind === "signed-in" && resolution.accountId).toBe("user-1")
    expect(Number.isNaN(Date.parse(resolution.checkedAt))).toBe(false)
  })

  test("reports an empty session as signed out", async () => {
    mocks.getSession = async () => null

    expect((await resolveSessionAccount()).kind).toBe("signed-out")
  })

  test("reports HTTP 401 as signed out, not as an unknown account", async () => {
    mocks.getSession = async () => {
      throw apiError(401)
    }

    expect((await resolveSessionAccount()).kind).toBe("signed-out")
  })

  test("keeps a failed check as unknown and never echoes the client's error text", async () => {
    mocks.getSession = async () => {
      throw apiError(500)
    }

    const resolution = await resolveSessionAccount()

    expect(resolution.kind).toBe("unknown")
    const reason = resolution.kind === "unknown" ? resolution.reason : ""
    expect(reason).toContain("500")
    // The agent sees this reason: no cookie, no headers, no session token.
    expect(reason.toLowerCase()).not.toContain("cookie")
    expect(reason).not.toContain("secret-session-token")
    expect(reason).not.toContain("better-auth")
  })

  test("keeps a network failure unknown without its message", async () => {
    mocks.getSession = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:3000 better-auth.session_token=secret")
    }

    const resolution = await resolveSessionAccount()

    expect(resolution.kind).toBe("unknown")
    const reason = resolution.kind === "unknown" ? resolution.reason : ""
    expect(reason).not.toContain("secret")
    expect(reason).not.toContain("ECONNREFUSED")
  })
})
