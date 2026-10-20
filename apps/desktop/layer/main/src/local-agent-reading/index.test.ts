/**
 * Wiring of the service into the app: the two settings keys and their defaults.
 *
 * The article page permission is a separate persisted flag, and an existing profile that has never
 * seen it must read it as off rather than as "whatever the store happens to return".
 */
import { describe, expect, test, vi } from "vitest"

const storeMock = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  get: vi.fn((key: string) => storeMock.data[key]),
  set: vi.fn((key: string, value: unknown) => {
    storeMock.data[key] = value
  }),
}))

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/folo-local-agent-reading-index-test", on: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (buffer: Buffer) => buffer.toString(),
  },
}))

vi.mock("~/logger", () => ({ logger: { info: vi.fn() } }))
vi.mock("~/manager/window", () => ({ WindowManager: { getMainWindow: () => null } }))
vi.mock("../lib/store", () => ({ store: storeMock, StoreKey: {} }))
// The app-bound halves of the wiring need a running Electron app; this test only checks the two
// persisted flags and their defaults.
vi.mock("./account", () => ({ resolveSessionAccount: vi.fn() }))
vi.mock("./provider", () => ({ createRendererDataProvider: () => ({}) }))

const { localAgentReadingService } = await import("./index")

describe("local agent reading settings", () => {
  test("an existing profile has article pages off", () => {
    storeMock.data = { localAgentReadingEnabled: true }

    expect(localAgentReadingService.settingsStatus()).toMatchObject({
      enabled: true,
      sourcePageEnabled: false,
    })
  })

  test("the permission has its own key and is read back from it", () => {
    storeMock.data = {}
    localAgentReadingService.setSourcePageEnabled(true)

    expect(storeMock.set).toHaveBeenCalledWith("localAgentReadingSourcePageEnabled", true)
    expect(localAgentReadingService.settingsStatus().sourcePageEnabled).toBe(true)
  })
})
