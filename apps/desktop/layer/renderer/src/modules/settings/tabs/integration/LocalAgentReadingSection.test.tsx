/**
 * The settings section of the local agent reading endpoint.
 *
 * What it must not do: show the token without being asked, pretend the endpoint is on, or offer a
 * control the main process cannot honour. What it must do: hide itself where there is no main
 * process, so the web build keeps working.
 */
import type { LocalAgentReadingSettingsStatus } from "@follow/shared/local-agent-reading"
import commonEn from "@locales/common/en.json"
import settingsEn from "@locales/settings/en.json"
import * as React from "react"
import { act } from "react"
import type { Root } from "react-dom/client"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

const ipc = vi.hoisted(() => ({ services: {} as { localAgentReading?: unknown } }))
const clipboard = vi.hoisted(() => ({ copyToClipboard: vi.fn(async () => {}) }))

vi.mock("~/lib/client", () => ({ ipcServices: ipc.services }))
vi.mock("~/lib/clipboard", () => clipboard)
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  const mockedTranslation = () => ({
    i18n: { language: "en" },
    t: (
      key: keyof typeof settingsEn | keyof typeof commonEn,
      options?: Record<string, unknown>,
    ) => {
      const template =
        settingsEn[key as keyof typeof settingsEn] ?? commonEn[key as keyof typeof commonEn] ?? key
      if (!options) return template
      return Object.entries(options).reduce(
        (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
        template,
      )
    },
  })

  return { ...actual, useTranslation: mockedTranslation }
})

const { LocalAgentReadingSection } = await import("./LocalAgentReadingSection")

const ENDPOINT = "http://127.0.0.1:41610/mcp"

const baseStatus = (
  overrides: Partial<LocalAgentReadingSettingsStatus> = {},
): LocalAgentReadingSettingsStatus => ({
  enabled: true,
  sourcePageEnabled: false,
  listening: true,
  endpoint: ENDPOINT,
  tokenPresent: true,
  tokenPersistence: "os-keyring",
  listenError: null,
  contractVersion: 1,
  limits: {
    maxEntriesPerScan: 2000,
    defaultListLimit: 50,
    maxListLimit: 100,
    defaultContentBatch: 5,
    maxContentBatch: 10,
    contentChunkChars: 6000,
  },
  ...overrides,
})

const createService = (status = baseStatus()) => {
  let current = status
  return {
    getStatus: vi.fn(async () => current),
    setEnabled: vi.fn(async ({ enabled }: { enabled: boolean }) => {
      current = baseStatus({
        enabled,
        sourcePageEnabled: current.sourcePageEnabled,
        listening: enabled,
        endpoint: enabled ? ENDPOINT : null,
        tokenPresent: enabled,
      })
      return current
    }),
    setSourcePageEnabled: vi.fn(({ enabled }: { enabled: boolean }) => {
      current = { ...current, sourcePageEnabled: enabled }
      return current
    }),
    revealToken: vi.fn(async () => ({
      ok: true,
      token: "folo-reading-token",
      persistence: "os-keyring" as const,
      reason: null,
    })),
    rotateToken: vi.fn(async () => ({
      ok: true,
      token: "rotated-reading-token",
      persistence: "os-keyring" as const,
      reason: null,
    })),
    revokeToken: vi.fn(async () => ({
      ok: true,
      token: null,
      persistence: "os-keyring" as const,
      reason: null,
    })),
  }
}

const buttonByText = (container: HTMLElement, text: string, index = 0) => {
  const button = Array.from(container.querySelectorAll("button")).filter((element) =>
    element.textContent?.trim().startsWith(text),
  )[index]
  if (!button) throw new Error(`button not found: ${text}`)
  return button as HTMLButtonElement
}

describe("LocalAgentReadingSection", () => {
  let root: Root | null = null
  let container: HTMLElement | null = null

  beforeAll(() => {
    ;(globalThis as typeof globalThis & { React: typeof React }).React = React
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
      root = null
    }
    container?.remove()
    container = null
    delete ipc.services.localAgentReading
    clipboard.copyToClipboard.mockClear()
  })

  const renderSection = async () => {
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<LocalAgentReadingSection />)
    })
    return container
  }

  it("shows the endpoint and the state of the service", async () => {
    ipc.services.localAgentReading = createService()
    const element = await renderSection()

    expect(element.textContent).toContain(ENDPOINT)
    expect(element.textContent).toContain("Listening")
    expect(element.textContent).toContain("Token ready")
    expect(element.textContent).toContain("Stored in the system keychain")
    expect(element.textContent).toContain("2000")
  })

  it("keeps the token hidden until it is revealed, then offers to copy it", async () => {
    const service = createService()
    ipc.services.localAgentReading = service
    const element = await renderSection()

    expect(element.textContent).not.toContain("folo-reading-token")
    expect(service.revealToken).not.toHaveBeenCalled()

    await act(async () => {
      buttonByText(element, "Reveal").click()
    })

    expect(service.revealToken).toHaveBeenCalledTimes(1)
    expect(element.textContent).toContain("folo-reading-token")

    // The endpoint has its own copy button; the token is the second one.
    await act(async () => {
      buttonByText(element, "Copy", 1).click()
    })
    expect(clipboard.copyToClipboard).toHaveBeenCalledWith("folo-reading-token")
  })

  it("switches the endpoint on and off through the main process", async () => {
    const service = createService(baseStatus({ enabled: false, listening: false, endpoint: null }))
    ipc.services.localAgentReading = service
    const element = await renderSection()

    const toggle = element.querySelector('[role="switch"]') as HTMLButtonElement | null
    expect(toggle).not.toBeNull()

    await act(async () => {
      toggle!.click()
    })

    expect(service.setEnabled).toHaveBeenCalledWith({ enabled: true })
    expect(element.textContent).toContain(ENDPOINT)
  })

  it("shows the article page permission as off and turns it on through the main process", async () => {
    const service = createService()
    ipc.services.localAgentReading = service
    const element = await renderSection()

    const switches = element.querySelectorAll('[role="switch"]')
    expect(switches).toHaveLength(2)
    const permission = switches[1] as HTMLButtonElement
    expect(element.textContent).toContain("Allow article page fetching")
    expect(permission.getAttribute("aria-checked")).toBe("false")

    await act(async () => {
      permission.click()
    })

    expect(service.setSourcePageEnabled).toHaveBeenCalledWith({ enabled: true })
  })

  it("keeps the article page permission off when the main process refuses", async () => {
    const service = createService()
    service.setSourcePageEnabled.mockRejectedValueOnce(new Error("refused"))
    ipc.services.localAgentReading = service
    const element = await renderSection()

    await act(async () => {
      ;(element.querySelectorAll('[role="switch"]')[1] as HTMLButtonElement).click()
    })

    expect(service.setSourcePageEnabled).toHaveBeenCalledTimes(1)
    const permission = element.querySelectorAll('[role="switch"]')[1] as HTMLButtonElement
    expect(permission.getAttribute("aria-checked")).toBe("false")
  })

  it("resets and revokes the token explicitly", async () => {
    const service = createService()
    ipc.services.localAgentReading = service
    const element = await renderSection()

    await act(async () => {
      buttonByText(element, "Reset token").click()
    })
    expect(service.rotateToken).toHaveBeenCalledTimes(1)
    expect(element.textContent).toContain("rotated-reading-token")

    await act(async () => {
      buttonByText(element, "Revoke").click()
    })
    expect(service.revokeToken).toHaveBeenCalledTimes(1)
    expect(element.textContent).not.toContain("rotated-reading-token")
  })

  it("says why the endpoint is not listening and that a session-only token is lost", async () => {
    ipc.services.localAgentReading = createService(
      baseStatus({
        listening: false,
        tokenPresent: false,
        tokenPersistence: "memory",
        endpoint: null,
        listenError: "EADDRINUSE",
      }),
    )
    const element = await renderSection()

    expect(element.textContent).toContain("The endpoint could not start")
    expect(element.textContent).toContain("EADDRINUSE")
    expect(element.textContent).toContain("Valid for this session only")
    expect(element.textContent).toContain(
      "This system has no keychain, so the token is kept for this session only.",
    )
  })

  it("renders nothing where there is no main process", async () => {
    delete ipc.services.localAgentReading
    const element = await renderSection()
    expect(element.innerHTML).toBe("")
  })
})
