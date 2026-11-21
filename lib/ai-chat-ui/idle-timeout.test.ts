import { describe, it, expect, vi, afterEach } from "vitest"
import { createIdleTimeout } from "./idle-timeout"

afterEach(() => vi.useRealTimers())

describe("idle timeout", () => {
  it("idle_timeout_fires_after_silence", () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    createIdleTimeout(60_000, fn)
    vi.advanceTimersByTime(59_999)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })
  it("idle_timeout_resets_on_chunk", () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const t = createIdleTimeout(60_000, fn)
    for (let i = 0; i < 10; i++) { vi.advanceTimersByTime(50_000); t.reset() }
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(fn).toHaveBeenCalledTimes(1)
  })
  it("idle_timeout_cleared", () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const t = createIdleTimeout(60_000, fn)
    t.clear()
    vi.advanceTimersByTime(120_000)
    t.reset()
    vi.advanceTimersByTime(120_000)
    expect(fn).not.toHaveBeenCalled()
  })
})
