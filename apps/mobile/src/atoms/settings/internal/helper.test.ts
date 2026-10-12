import { EventBus } from "@follow/utils/event-bus"
import { describe, expect, test, vi } from "vitest"

import { createSettingAtom } from "./helper"

/**
 * The settings helper writes atom state and tells the app about it. The order of those two steps is
 * what a subscriber depends on: it reacts to the change by reading the settings again, so it has to
 * see the value that was just written.
 *
 * The environment of the helper (the atom store, the event bus, the native storage) is replaced
 * here; the behaviour under test is `setSetting` itself.
 */
const mocks = vi.hoisted(() => ({
  listeners: new Set<(payload: unknown) => void>(),
  defaults: { value: "default", other: 1 },
}))

vi.mock("@follow/utils/event-bus", () => ({
  EventBus: {
    dispatch: (_event: string, payload?: unknown) => {
      for (const listener of [...mocks.listeners]) listener(payload)
    },
    subscribe: (_event: string, callback: (payload: unknown) => void) => {
      mocks.listeners.add(callback)
      return () => mocks.listeners.delete(callback)
    },
  },
}))

vi.mock("@follow/utils", () => {
  const values = new Map<unknown, unknown>()

  return {
    // The accessors `createSettingAtom` destructures; the value lives here, so the test observes
    // exactly what `setSetting` wrote.
    createAtomHooks: (atom: unknown) => [
      () => undefined,
      () => undefined,
      () => values.get(atom) ?? mocks.defaults,
      () => undefined,
      () => (values.get(atom) ?? mocks.defaults) as never,
      (value: unknown) => {
        values.set(atom, value)
      },
      () => undefined,
    ],
  }
})

vi.mock("@follow/hooks", () => ({ useRefValue: (value: unknown) => value }))

vi.mock("@/src/lib/jotai", () => {
  const storage = new Map<string, string>()
  return {
    JotaiPersistSyncStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value)
      },
      removeItem: (key: string) => {
        storage.delete(key)
      },
    },
  }
})

const settings = createSettingAtom("@test-settings", () => ({
  value: "default",
  other: 1,
}))

describe("setSetting", () => {
  test("writes the new value before a subscriber can read the settings", () => {
    const seen: string[] = []
    const unsubscribe = EventBus.subscribe("SETTING_CHANGE_EVENT" as never, () => {
      // A subscriber (the Local AI wiring) reacts by reading the settings again; dispatching before
      // the write handed it the previous value.
      seen.push(settings.getSettings().value)
    })

    try {
      settings.setSetting("value", "updated")
    } finally {
      unsubscribe()
    }

    expect(seen).toEqual(["updated"])
    expect(settings.getSettings()).toMatchObject({ value: "updated", other: 1 })
  })

  test("keeps the settings that were not part of the change", () => {
    settings.setSetting("other", 2)

    expect(settings.getSettings()).toMatchObject({ value: "updated", other: 2 })
  })
})
