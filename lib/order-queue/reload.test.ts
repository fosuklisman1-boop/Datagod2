import { describe, it, expect, vi } from "vitest"
import { makeQueueReloader } from "./reload"

describe("makeQueueReloader", () => {
  it("reloads with the params current at CALL time, not creation time", () => {
    let current = { view: "needs_action" }
    const load = vi.fn()
    const clear = vi.fn()
    const reload = makeQueueReloader(() => current, load, clear)
    current = { view: "failed" } // filters changed while e.g. a batch was running
    reload()
    expect(load).toHaveBeenCalledWith({ view: "failed" }, false)
    expect(clear).toHaveBeenCalledTimes(1)
  })
  it("clears the selection before loading", () => {
    const order: string[] = []
    makeQueueReloader(() => 1, () => order.push("load"), () => order.push("clear"))()
    expect(order).toEqual(["clear", "load"])
  })
})
