// lib/rate-limiter.test.ts
// applyRateLimit: the opt-in Postgres fallback (Task 6). Redis and Supabase are mocked.
import { describe, it, expect, vi, beforeEach } from "vitest"

const limitMock = vi.fn()
let redisEnv: { url: string; token: string } | null = { url: "https://redis.test", token: "t" }

vi.mock("@upstash/redis", () => ({ Redis: class {} }))
vi.mock("@upstash/ratelimit", () => {
  class Ratelimit {
    static slidingWindow() { return {} }
    limit(key: string) { return limitMock(key) }
  }
  return { Ratelimit }
})
vi.mock("@/lib/redis-env", () => ({ getRedisRestEnv: () => redisEnv }))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({ insert: () => Promise.resolve({ error: null }) }) }),
}))

function req(): any {
  return { headers: { get: (h: string) => (h === "x-vercel-forwarded-for" ? "1.2.3.4" : null) } }
}

async function load() {
  vi.resetModules()
  return await import("@/lib/rate-limiter")
}

describe("applyRateLimit pgFallback", () => {
  const stub = vi.fn()
  beforeEach(() => {
    redisEnv = { url: "https://redis.test", token: "t" }
    limitMock.mockReset()
    stub.mockReset()
  })

  it("Redis throws + pgFallback + stub allows => fallback result, not degraded", async () => {
    const m = await load()
    m.__setPgFallbackForTests(stub)
    limitMock.mockRejectedValue(new Error("max requests limit exceeded"))
    stub.mockResolvedValue({ allowed: true, remaining: 4, resetAt: 123 })
    const r = await m.applyRateLimit(req(), "v2-purchase", 5, 60_000, "a", { pgFallback: true })
    expect(r).toEqual({ allowed: true, remaining: 4, resetAt: 123, degraded: false, fallback: true })
    expect(stub).toHaveBeenCalledWith("v2-purchase:user:a", 5, 60_000)
  })

  it("Redis unconfigured + pgFallback uses the fallback too", async () => {
    redisEnv = null
    const m = await load()
    m.__setPgFallbackForTests(stub)
    stub.mockResolvedValue({ allowed: false, remaining: 0, resetAt: 9 })
    const r = await m.applyRateLimit(req(), "v2-purchase", 5, 60_000, "a", { pgFallback: true })
    expect(r).toEqual({ allowed: false, remaining: 0, resetAt: 9, degraded: false, fallback: true })
  })

  it("stub returns null => degraded true as today", async () => {
    const m = await load()
    m.__setPgFallbackForTests(stub)
    limitMock.mockRejectedValue(new Error("down"))
    stub.mockResolvedValue(null)
    const r = await m.applyRateLimit(req(), "v2-purchase", 5, 60_000, "a", { pgFallback: true })
    expect(r.degraded).toBe(true)
    expect(r.allowed).toBe(true)
    expect(r.fallback).toBeUndefined()
  })

  it("Redis healthy => the stub is never called", async () => {
    const m = await load()
    m.__setPgFallbackForTests(stub)
    limitMock.mockResolvedValue({ success: true, remaining: 3, reset: 55 })
    const r = await m.applyRateLimit(req(), "v2-purchase", 5, 60_000, "a", { pgFallback: true })
    expect(r).toEqual({ allowed: true, remaining: 3, resetAt: 55, degraded: false })
    expect(stub).not.toHaveBeenCalled()
  })

  it("no opts and Redis throws => the stub is never called, degraded true", async () => {
    const m = await load()
    m.__setPgFallbackForTests(stub)
    limitMock.mockRejectedValue(new Error("down"))
    const r = await m.applyRateLimit(req(), "v1-x", 5, 60_000, "a")
    expect(stub).not.toHaveBeenCalled()
    expect(r.degraded).toBe(true)
  })

  it("buckets for different users differ", async () => {
    const m = await load()
    m.__setPgFallbackForTests(stub)
    limitMock.mockRejectedValue(new Error("down"))
    stub.mockResolvedValue({ allowed: true, remaining: 1, resetAt: 1 })
    await m.applyRateLimit(req(), "v2-purchase", 5, 60_000, "a", { pgFallback: true })
    await m.applyRateLimit(req(), "v2-purchase", 5, 60_000, "b", { pgFallback: true })
    const [a, b] = stub.mock.calls.map(c => c[0])
    expect(a).toBe("v2-purchase:user:a")
    expect(b).toBe("v2-purchase:user:b")
    expect(a).not.toBe(b)
  })
})
