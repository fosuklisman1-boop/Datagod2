import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { startPoller } from "./poller"

describe("startPoller", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const opts = { fastMs: 5000, slowMs: 15000, backoffAfterMs: 120000 }

  it("polls every 5s then backs off to 15s after 2 minutes", async () => {
    const load = vi.fn().mockResolvedValue(undefined)
    const p = startPoller({ ...opts, load, isHidden: () => false })
    await vi.advanceTimersByTimeAsync(5000)
    expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000 * 23) // reach 120s
    expect(load).toHaveBeenCalledTimes(24)
    await vi.advanceTimersByTimeAsync(5000) // t=125, last fast tick
    expect(load).toHaveBeenCalledTimes(25)
    await vi.advanceTimersByTimeAsync(10000) // t=135, next is 15s later
    expect(load).toHaveBeenCalledTimes(25)
    await vi.advanceTimersByTimeAsync(5000) // t=140
    expect(load).toHaveBeenCalledTimes(26)
    p.stop()
  })

  it("skips load while hidden", async () => {
    const load = vi.fn().mockResolvedValue(undefined)
    const p = startPoller({ ...opts, load, isHidden: () => true })
    await vi.advanceTimersByTimeAsync(20000)
    expect(load).not.toHaveBeenCalled()
    p.stop()
  })

  it("does not reschedule when stopped while a load is in flight", async () => {
    let release!: () => void
    const load = vi.fn().mockImplementation(() => new Promise<void>((r) => (release = r)))
    const p = startPoller({ ...opts, load, isHidden: () => false })
    await vi.advanceTimersByTimeAsync(5000)
    expect(load).toHaveBeenCalledTimes(1)
    p.stop() // cleanup runs while the callback is suspended
    release()
    await vi.advanceTimersByTimeAsync(60000)
    expect(load).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("stop prevents any further loads", async () => {
    const load = vi.fn().mockResolvedValue(undefined)
    const p = startPoller({ ...opts, load, isHidden: () => false })
    p.stop()
    await vi.advanceTimersByTimeAsync(60000)
    expect(load).not.toHaveBeenCalled()
  })
})
