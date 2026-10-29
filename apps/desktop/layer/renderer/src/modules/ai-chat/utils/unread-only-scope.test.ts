import { describe, expect, it } from "vitest"
import { createStore } from "zustand/vanilla"

import type { BlockSlice } from "../store/slices/block.slice"
import { BlockSliceAction, createBlockSlice } from "../store/slices/block.slice"
import { isUnreadOnlyScope, setUnreadOnlyScope } from "./unread-only-scope"

const setup = () => {
  const store = createStore<BlockSlice>()(createBlockSlice())
  return { store, actions: store.getState().blockActions }
}

const unreadBlock = (store: ReturnType<typeof setup>["store"]) =>
  store.getState().blocks.filter((block) => block.type === "unreadOnly")

describe("the panel's unread scope", () => {
  it("adds the block the context builder reads", () => {
    const { store, actions } = setup()

    setUnreadOnlyScope(actions, true)

    expect(unreadBlock(store)).toEqual([
      { id: BlockSliceAction.SPECIAL_TYPES.unreadOnly, type: "unreadOnly", value: "true" },
    ])
    expect(isUnreadOnlyScope(store.getState().blocks)).toBe(true)
  })

  it("turns off without touching the timeline scope", () => {
    const { store, actions } = setup()
    actions.addOrUpdateBlock({ id: "mainView", type: "mainView", value: "0" })
    setUnreadOnlyScope(actions, true)

    setUnreadOnlyScope(actions, false)

    expect(unreadBlock(store)).toEqual([])
    expect(store.getState().blocks).toEqual([{ id: "mainView", type: "mainView", value: "0" }])
  })

  it("is idempotent, so a repeated press cannot stack blocks", () => {
    const { store, actions } = setup()

    setUnreadOnlyScope(actions, true)
    setUnreadOnlyScope(actions, true)

    expect(unreadBlock(store)).toHaveLength(1)
  })

  it("reports the scope from the blocks alone", () => {
    const { store, actions } = setup()

    expect(isUnreadOnlyScope(store.getState().blocks)).toBe(false)

    setUnreadOnlyScope(actions, true)
    expect(isUnreadOnlyScope(store.getState().blocks)).toBe(true)
  })
})
