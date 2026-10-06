// lib/ussd-hubtel/billing-guard.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({ set: vi.fn(), del: vi.fn() }))

// No UPSTASH env in unit tests: the first describe exercises the in-process (dev) path, same SET NX semantics.
describe("shopBillingGuard (no redis configured)", () => {
  it("claims once per (session, code), then reports already", async () => {
    const { shopBillingGuard } = await import("./billing-guard")
    expect(await shopBillingGuard.claim("bg-1", "code-1")).toBe("claimed")
    expect(await shopBillingGuard.claim("bg-1", "code-1")).toBe("already")
  })
  it("a different session or a different code is a separate claim", async () => {
    const { shopBillingGuard } = await import("./billing-guard")
    expect(await shopBillingGuard.claim("bg-2", "code-1")).toBe("claimed")
    expect(await shopBillingGuard.claim("bg-2", "code-2")).toBe("claimed")
    expect(await shopBillingGuard.claim("bg-3", "code-1")).toBe("claimed")
  })
  it("release lets the same session claim again (deduction did not happen)", async () => {
    const { shopBillingGuard } = await import("./billing-guard")
    expect(await shopBillingGuard.claim("bg-4", "code-1")).toBe("claimed")
    await shopBillingGuard.release("bg-4", "code-1")
    expect(await shopBillingGuard.claim("bg-4", "code-1")).toBe("claimed")
  })
  it("two concurrent claims: exactly one wins", async () => {
    const { shopBillingGuard } = await import("./billing-guard")
    const r = await Promise.all([shopBillingGuard.claim("bg-5", "c"), shopBillingGuard.claim("bg-5", "c")])
    expect([...r].sort()).toEqual(["already", "claimed"])
  })
})

describe("shopBillingGuard (redis configured)", () => {
  beforeEach(() => {
    vi.resetModules()
    h.set.mockReset()
    h.del.mockReset()
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example")
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "tok")
    vi.doMock("@upstash/redis", () => ({
      Redis: class { set = h.set; del = h.del },
    }))
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("SET NX with a TTL on a per-(session, code) key: OK means claimed, null means already", async () => {
    const { shopBillingGuard, SHOP_BILLING_TTL_SECONDS } = await import("./billing-guard")
    h.set.mockResolvedValueOnce("OK").mockResolvedValueOnce(null)
    expect(await shopBillingGuard.claim("S1", "code-1")).toBe("claimed")
    expect(await shopBillingGuard.claim("S1", "code-1")).toBe("already")
    expect(h.set).toHaveBeenCalledWith("ussd-hubtel:shop-billed:S1:code-1", "1", { nx: true, ex: SHOP_BILLING_TTL_SECONDS })
  })
  it("a Redis error on claim is 'error' (caller must not deduct)", async () => {
    const { shopBillingGuard } = await import("./billing-guard")
    h.set.mockRejectedValue(new Error("redis down"))
    expect(await shopBillingGuard.claim("S1", "code-1")).toBe("error")
  })
  it("release deletes the marker key; a failing delete never throws", async () => {
    const { shopBillingGuard } = await import("./billing-guard")
    h.del.mockResolvedValueOnce(1)
    await shopBillingGuard.release("S1", "code-1")
    expect(h.del).toHaveBeenCalledWith("ussd-hubtel:shop-billed:S1:code-1")
    h.del.mockRejectedValue(new Error("redis down"))
    await expect(shopBillingGuard.release("S1", "code-1")).resolves.toBeUndefined()
  })
})
