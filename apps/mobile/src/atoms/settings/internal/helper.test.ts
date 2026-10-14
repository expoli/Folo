import { UserRole } from "@follow/constants"
import { configureLocalAI, resetLocalAI } from "@follow/store/ai-local/config"
import { useUserStore } from "@follow/store/user/store"
import { jotaiStore } from "@follow/utils"
import { EventBus } from "@follow/utils/event-bus"
import { beforeEach, describe, expect, it, test, vi } from "vitest"

import { createSettingAtom } from "./helper"

const mocks = vi.hoisted(() => {
  // Read by the shared constants at import
  vi.stubGlobal("ELECTRON", false)
  return {
    storage: new Map<string, string>(),
    dispatch: vi.fn(),
    listeners: new Set<(payload: unknown) => void>(),
  }
})

vi.mock("@/src/lib/jotai", () => ({
  JotaiPersistSyncStorage: {
    getItem: <Value>(key: string, defaultValue: Value): Value => {
      const value = mocks.storage.get(key)
      return value === undefined ? defaultValue : JSON.parse(value)
    },
    setItem: (key: string, value: unknown) => {
      mocks.storage.set(key, JSON.stringify(value))
    },
    removeItem: (key: string) => {
      mocks.storage.delete(key)
    },
    subscribe: () => () => {},
  },
}))

// The hooks package reads the browser window at import
vi.mock("@follow/hooks", () => ({
  useRefValue: <T>(value: T) => ({ current: value }),
}))

vi.mock("@follow/store/user/store", async () => {
  const { create } = await import("zustand")
  return { useUserStore: create<{ role: UserRole | null }>(() => ({ role: null })) }
})

// The dispatch reaches the subscribers synchronously, as the real bus does; the ordering of the
// write and the dispatch is what the `setSetting` test below observes.
vi.mock("@follow/utils/event-bus", () => ({
  EventBus: {
    dispatch: (event: string, payload?: unknown) => {
      mocks.dispatch(event, payload)
      for (const listener of [...mocks.listeners]) listener(payload)
    },
    subscribe: (_event: string, callback: (payload: unknown) => void) => {
      mocks.listeners.add(callback)
      return () => mocks.listeners.delete(callback)
    },
  },
}))

const setRole = (role: UserRole | null) => useUserStore.setState({ role })

// "translation" needs the Basic plan, the free plan limits "summary", and "unreadOnly" is free
const createDefaults = () => ({
  translation: false,
  translationMode: "bilingual",
  summary: true,
  hidePrivateSubscriptionsInTimeline: false,
  unreadOnly: false,
})
const { getSettings, setSetting, settingAtom } = createSettingAtom("general", createDefaults)
const saved = () => jotaiStore.get(settingAtom)

const enableLocalAI = () => configureLocalAI({ baseUrl: "http://127.0.0.1:8788" })

describe("createSettingAtom paid settings", () => {
  beforeEach(() => {
    mocks.dispatch.mockClear()
    setRole(null)
    jotaiStore.set(settingAtom, {
      ...createDefaults(),
      translation: true,
      summary: false,
      unreadOnly: true,
    })
  })

  it.each([UserRole.Free, UserRole.Trial])(
    "reads a paid setting a %s plan lacks as its default and keeps the saved value",
    (role) => {
      setRole(role)

      expect(getSettings()).toMatchObject({ translation: false, summary: false, unreadOnly: true })
      expect(saved().translation).toBe(true)
    },
  )

  it.each([
    ["a paid plan", UserRole.Basic],
    ["an unknown role, while it loads or signed out", null],
  ])("reads the saved paid settings for %s", (_, role) => {
    setRole(role)

    expect(getSettings()).toMatchObject({ translation: true, summary: false, unreadOnly: true })
  })

  it("does not turn on a paid setting the plan lacks", () => {
    jotaiStore.set(settingAtom, createDefaults())
    setRole(UserRole.Free)

    setSetting("translation", true)

    expect(saved().translation).toBe(false)
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })

  it("still turns off a paid setting the plan lacks, and saves the other settings", () => {
    setRole(UserRole.Free)

    setSetting("translation", false)
    setSetting("summary", true)
    setSetting("unreadOnly", false)

    expect(saved()).toMatchObject({ translation: false, summary: true, unreadOnly: false })
    expect(mocks.dispatch).toHaveBeenCalledTimes(3)
  })

  it("turns on a paid setting for a paid plan", () => {
    jotaiStore.set(settingAtom, createDefaults())
    setRole(UserRole.Pro)

    setSetting("translation", true)

    expect(getSettings().translation).toBe(true)
    expect(mocks.dispatch).toHaveBeenCalledWith("SETTING_CHANGE_EVENT", {
      key: "general",
      payload: { translation: true },
    })
  })
})

describe("createSettingAtom paid settings with local AI", () => {
  beforeEach(() => {
    mocks.dispatch.mockClear()
    resetLocalAI()
    setRole(null)
    jotaiStore.set(settingAtom, {
      ...createDefaults(),
      translation: true,
      summary: false,
      unreadOnly: true,
    })
  })

  it.each([UserRole.Free, UserRole.Trial])(
    "reads the saved translation setting for a %s plan while local AI answers",
    (role) => {
      enableLocalAI()
      setRole(role)

      expect(getSettings()).toMatchObject({ translation: true, summary: false, unreadOnly: true })
    },
  )

  it.each([UserRole.Free, UserRole.Trial])(
    "turns the translation setting off and on again for a %s plan while local AI answers",
    (role) => {
      enableLocalAI()
      setRole(role)

      setSetting("translation", false)
      expect(saved().translation).toBe(false)

      setSetting("translation", true)
      expect(saved().translation).toBe(true)
      expect(getSettings().translation).toBe(true)
    },
  )

  it("keeps the saved translation mode usable while local AI answers", () => {
    enableLocalAI()
    setRole(UserRole.Free)
    jotaiStore.set(settingAtom, { ...createDefaults(), translationMode: "translation-only" })

    expect(getSettings().translationMode).toBe("translation-only")

    setSetting("translationMode", "bilingual")

    expect(getSettings().translationMode).toBe("bilingual")
    expect(saved().translationMode).toBe("bilingual")
  })

  it("locks the translation settings again once local AI is off, and can still turn them off", () => {
    enableLocalAI()
    setRole(UserRole.Free)

    resetLocalAI()

    // The plan locks them again: the app reads the default, the saved value stays.
    expect(getSettings().translation).toBe(false)
    expect(saved().translation).toBe(true)

    // Turning the setting off is still allowed and saved...
    setSetting("translation", false)
    expect(saved().translation).toBe(false)

    // ...turning it on is not.
    setSetting("translation", true)
    expect(saved().translation).toBe(false)
  })

  it("leaves the settings local AI does not answer locked for a free plan", () => {
    enableLocalAI()
    setRole(UserRole.Free)
    jotaiStore.set(settingAtom, createDefaults())

    setSetting("hidePrivateSubscriptionsInTimeline", true)

    expect(saved().hidePrivateSubscriptionsInTimeline).toBe(false)
  })
})

/**
 * The settings helper writes atom state and tells the app about it. The order of those two steps is
 * what a subscriber depends on: it reacts to the change by reading the settings again, so it has to
 * see the value that was just written.
 */
describe("setSetting", () => {
  const orderSettings = createSettingAtom("test-order", () => ({ value: "default", other: 1 }))

  test("writes the new value before a subscriber can read the settings", () => {
    const seen: string[] = []
    const unsubscribe = EventBus.subscribe("SETTING_CHANGE_EVENT" as never, () => {
      // A subscriber (the Local AI wiring) reacts by reading the settings again; dispatching before
      // the write handed it the previous value.
      seen.push(orderSettings.getSettings().value)
    })

    try {
      orderSettings.setSetting("value", "updated")
    } finally {
      unsubscribe()
    }

    expect(seen).toEqual(["updated"])
    expect(orderSettings.getSettings()).toMatchObject({ value: "updated", other: 1 })
  })

  test("keeps the settings that were not part of the change", () => {
    orderSettings.setSetting("value", "updated")
    orderSettings.setSetting("other", 2)

    expect(orderSettings.getSettings()).toMatchObject({ value: "updated", other: 2 })
  })
})
