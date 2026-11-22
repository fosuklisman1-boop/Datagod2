import { describe, it, expect, vi, beforeEach } from "vitest"

const runNotify = vi.fn(async (_o?: unknown) => ({}))
const after = vi.fn((fn: () => unknown) => { void fn() })
const settings = vi.fn(async () => ({ enabled: true }))
vi.mock("./notify", () => ({ runNotify: (o?: unknown) => runNotify(o) }))
vi.mock("./settings", () => ({ getBlockedNumbersSettings: () => settings() }))
vi.mock("next/server", () => ({ after: (fn: () => unknown) => after(fn) }))

import { scheduleNotifyNow } from "./notify-now"

beforeEach(() => {
  runNotify.mockClear(); after.mockClear(); settings.mockClear()
  after.mockImplementation((fn) => { void fn() })
  settings.mockResolvedValue({ enabled: true })
})

describe("scheduleNotifyNow", () => {
  it("schedules runNotify via after() with a deadline 240 s after the request start", async () => {
    expect(await scheduleNotifyNow({ startedAt: 1_000 })).toBe(true)
    await Promise.resolve()
    expect(after).toHaveBeenCalledTimes(1)
    expect(runNotify).toHaveBeenCalledWith({ deadlineAt: 241_000 })
  })
  it("a runNotify rejection inside after() never escapes", async () => {
    runNotify.mockRejectedValueOnce(new Error("sms down"))
    await expect(scheduleNotifyNow({ startedAt: 0 })).resolves.toBe(true)
  })
  it("when after() throws it does NOT run inline and returns false", async () => {
    after.mockImplementation(() => { throw new Error("outside request scope") })
    expect(await scheduleNotifyNow({ startedAt: 0 })).toBe(false)
    expect(runNotify).not.toHaveBeenCalled()
  })
  it("master switch off: nothing is scheduled or sent", async () => {
    settings.mockResolvedValue({ enabled: false })
    expect(await scheduleNotifyNow({ startedAt: 0 })).toBe(false)
    expect(after).not.toHaveBeenCalled()
    expect(runNotify).not.toHaveBeenCalled()
  })
  it("a settings read failure returns false without notifying", async () => {
    settings.mockRejectedValue(new Error("db"))
    expect(await scheduleNotifyNow({ startedAt: 0 })).toBe(false)
    expect(runNotify).not.toHaveBeenCalled()
  })
})
