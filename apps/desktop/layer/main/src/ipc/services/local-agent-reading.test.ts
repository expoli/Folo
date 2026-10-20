import { describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  /** Methods the `@IpcMethod()` decorator collected, i.e. the IPC surface of the service. */
  methods: [] as string[],
  mainWindow: null as unknown,
  sender: null as unknown,
  service: {
    settingsStatus: vi.fn(() => ({ enabled: true, sourcePageEnabled: false, listening: true })),
    setEnabled: vi.fn(async (enabled: boolean) => ({ enabled, listening: enabled })),
    setSourcePageEnabled: vi.fn((enabled: boolean) => ({ sourcePageEnabled: enabled })),
    revealToken: vi.fn(() => ({
      ok: true,
      token: "folo_lar_x",
      persistence: "memory",
      reason: null,
    })),
    rotateToken: vi.fn(() => ({
      ok: true,
      token: "folo_lar_y",
      persistence: "memory",
      reason: null,
    })),
    revokeToken: vi.fn(() => ({ ok: true, token: null, persistence: "memory", reason: null })),
  },
}))

vi.mock("electron-ipc-decorator", () => ({
  IpcMethod: () => (_target: unknown, propertyKey: string, descriptor: PropertyDescriptor) => {
    mocks.methods.push(propertyKey)
    return descriptor
  },
  IpcService: class {
    protected handler = { sendToRenderer: vi.fn() }
  },
  getIpcContext: () => ({ sender: mocks.sender }),
}))

vi.mock("../../manager/window", () => ({
  WindowManager: { getMainWindow: () => mocks.mainWindow },
}))

vi.mock("../../local-agent-reading", () => ({
  localAgentReadingService: mocks.service,
  startLocalAgentReading: vi.fn(),
}))

const { LocalAgentReadingIpcService } = await import("./local-agent-reading")

const registeredMethods = [...mocks.methods]

const trustedWindow = () => {
  const window = { isDestroyed: () => false, webContents: { id: 1 } }
  mocks.mainWindow = window
  mocks.sender = window.webContents
  return window
}

describe("LocalAgentReadingIpcService", () => {
  test("exposes the settings surface under its own group", () => {
    new LocalAgentReadingIpcService()

    expect(registeredMethods).toEqual([
      "getStatus",
      "setEnabled",
      "setSourcePageEnabled",
      "revealToken",
      "rotateToken",
      "revokeToken",
    ])
    expect(LocalAgentReadingIpcService.groupName).toBe("localAgentReading")
  })

  test("serves the main window", () => {
    trustedWindow()
    const service = new LocalAgentReadingIpcService()

    expect(service.getStatus()).toEqual({
      enabled: true,
      sourcePageEnabled: false,
      listening: true,
    })
    expect(service.revealToken()).toMatchObject({ ok: true, token: "folo_lar_x" })
  })

  test("refuses another renderer, so the token cannot be read from a webview", () => {
    trustedWindow()
    mocks.sender = { id: 2 }
    const service = new LocalAgentReadingIpcService()

    expect(() => service.getStatus()).toThrow(/main window/)
    expect(() => service.setSourcePageEnabled({ enabled: true })).toThrow(/main window/)
    expect(() => service.revealToken()).toThrow(/main window/)
    expect(() => service.rotateToken()).toThrow(/main window/)
    expect(() => service.revokeToken()).toThrow(/main window/)
  })

  test("refuses every call when there is no main window", () => {
    mocks.mainWindow = null
    mocks.sender = { id: 3 }
    const service = new LocalAgentReadingIpcService()

    expect(() => service.getStatus()).toThrow(/main window/)
  })

  test("forwards the switch to the service", async () => {
    trustedWindow()
    const service = new LocalAgentReadingIpcService()

    await expect(service.setEnabled({ enabled: false })).resolves.toEqual({
      enabled: false,
      listening: false,
    })
    expect(mocks.service.setEnabled).toHaveBeenCalledWith(false)
  })

  test("forwards the article page permission to the service", () => {
    trustedWindow()
    const service = new LocalAgentReadingIpcService()

    expect(service.setSourcePageEnabled({ enabled: true })).toEqual({ sourcePageEnabled: true })
    expect(mocks.service.setSourcePageEnabled).toHaveBeenCalledWith(true)
  })
})
