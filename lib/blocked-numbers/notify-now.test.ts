import { describe, it, expect, vi, beforeEach } from "vitest"

const runNotify = vi.fn(async (_o?: unknown) => ({}))
const after = vi.fn((fn: () => unknown) => { void fn() })
vi.mock("./notify", () => ({ runNotify: (o?: unknown) => runNotify(o) }))
vi.mock("next/server", () => ({ after: (fn: () => unknown) => after(fn) }))

import { scheduleNotifyNow } from "./notify-now"

beforeEach(() => { runNotify.mockClear(); after.mockClear(); after.mockImplementation((fn) => { void fn() }) })

describe("scheduleNotifyNow", () => {
  it("schedules runNotify via after() and returns true", async () => {
    expect(await scheduleNotifyNow()).toBe(true)
    expect(after).toHaveBeenCalledTimes(1)
    expect(runNotify).toHaveBeenCalledTimes(1)
  })
  it("a runNotify rejection inside after() never escapes", async () => {
    runNotify.mockRejectedValueOnce(new Error("sms down"))
    await expect(scheduleNotifyNow()).resolves.toBe(true)
  })
  it("falls back to awaiting runNotify when after() throws; a failure there returns false, never throws", async () => {
    after.mockImplementation(() => { throw new Error("outside request scope") })
    expect(await scheduleNotifyNow()).toBe(true)
    expect(runNotify).toHaveBeenCalledTimes(1)
    after.mockImplementation(() => { throw new Error("x") })
    runNotify.mockRejectedValueOnce(new Error("boom"))
    await expect(scheduleNotifyNow()).resolves.toBe(false)
  })
})
