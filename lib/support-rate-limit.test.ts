import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const applyRateLimit = vi.fn()
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: (...a: unknown[]) => applyRateLimit(...a) }))

import { checkSupportRateLimit, __resetSupportRateLimitMemory } from "./support-rate-limit"

const req = {} as any

beforeEach(() => {
  applyRateLimit.mockReset()
  __resetSupportRateLimitMemory()
})
afterEach(() => vi.useRealTimers())

describe("checkSupportRateLimit", () => {
  it("passes the limit parameters to the shared limiter", async () => {
    applyRateLimit.mockResolvedValue({ allowed: true, remaining: 1, resetAt: 0, degraded: false })
    await checkSupportRateLimit(req, "thread_create", "u1")
    expect(applyRateLimit).toHaveBeenCalledWith(req, "support_thread_create", 3, 3_600_000, "u1")
    await checkSupportRateLimit(req, "message_send", "u1")
    expect(applyRateLimit).toHaveBeenCalledWith(req, "support_message_send", 10, 60_000, "u1")
  })

  it("refuses when the healthy limiter refuses", async () => {
    applyRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: 0, degraded: false })
    expect(await checkSupportRateLimit(req, "message_send", "u1")).toEqual({ allowed: false })
  })

  it("falls back to memory when degraded: 3 thread creates per hour per user", async () => {
    applyRateLimit.mockResolvedValue({ allowed: true, remaining: 3, resetAt: 0, degraded: true })
    const results = []
    for (let i = 0; i < 4; i++) results.push((await checkSupportRateLimit(req, "thread_create", "u1")).allowed)
    expect(results).toEqual([true, true, true, false])
    expect((await checkSupportRateLimit(req, "thread_create", "u2")).allowed).toBe(true)
  })

  it("degraded message_send: 10 per minute, then allowed after the window", async () => {
    vi.useFakeTimers()
    applyRateLimit.mockResolvedValue({ allowed: true, remaining: 3, resetAt: 0, degraded: true })
    for (let i = 0; i < 10; i++) expect((await checkSupportRateLimit(req, "message_send", "u1")).allowed).toBe(true)
    expect((await checkSupportRateLimit(req, "message_send", "u1")).allowed).toBe(false)
    vi.advanceTimersByTime(60_001)
    expect((await checkSupportRateLimit(req, "message_send", "u1")).allowed).toBe(true)
  })

  it("treats a throwing limiter as degraded", async () => {
    applyRateLimit.mockRejectedValue(new Error("boom"))
    const results = []
    for (let i = 0; i < 4; i++) results.push((await checkSupportRateLimit(req, "thread_create", "u1")).allowed)
    expect(results).toEqual([true, true, true, false])
  })

  it("does not count refused attempts against the window", async () => {
    vi.useFakeTimers()
    applyRateLimit.mockResolvedValue({ allowed: true, remaining: 3, resetAt: 0, degraded: true })
    for (let i = 0; i < 3; i++) await checkSupportRateLimit(req, "thread_create", "u1")
    vi.advanceTimersByTime(1_800_000)
    for (let i = 0; i < 5; i++) await checkSupportRateLimit(req, "thread_create", "u1") // refused
    vi.advanceTimersByTime(1_800_001) // first three now expired
    expect((await checkSupportRateLimit(req, "thread_create", "u1")).allowed).toBe(true)
  })
})
