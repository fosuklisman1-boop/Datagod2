// The shop bot's per-sender charge claim: atomic in Redis, closed when Redis can't answer, in-process only when Redis
// isn't configured at all (the shop sessions are in-process then too).
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  keys: new Map<string, string>(),
  setCalls: [] as any[][],
  setFails: false,
  delFails: false,
  ctorFails: false,
}))

vi.mock("@upstash/redis", () => ({
  Redis: class {
    constructor() { if (h.ctorFails) throw new Error("bad config") }
    async set(k: string, v: string, o: any) {
      h.setCalls.push([k, v, o])
      if (h.setFails) throw new Error("redis down")
      if (o?.nx && h.keys.has(k)) return null
      h.keys.set(k, v)
      return "OK"
    }
    async del(k: string) {
      if (h.delFails) throw new Error("redis down")
      h.keys.delete(k)
      return 1
    }
  },
}))

const alertMock = vi.fn(async (..._a: any[]) => {})
vi.mock("@/lib/hubtel-pay/alert-throttle", () => ({ sendThrottledAlert: (...a: any[]) => alertMock(...a) }))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

const SENDER = "233244123456"

async function load(configured: boolean) {
  vi.resetModules()
  if (configured) {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.invalid")
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test")
  } else {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "")
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "")
  }
  return import("./shop-charge-claim")
}

beforeEach(() => {
  h.keys.clear()
  h.setCalls = []
  h.setFails = false
  h.delFails = false
  h.ctorFails = false
  alertMock.mockReset()
  alertMock.mockImplementation(async () => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe("with Redis", () => {
  it("one claim per sender at a time; concurrent claims get exactly one winner", async () => {
    const c = await load(true)
    const results = await Promise.all([c.claimShopCharge(SENDER), c.claimShopCharge(SENDER), c.claimShopCharge(SENDER)])
    expect(results.filter((r) => r === "claimed")).toHaveLength(1)
    expect(results.filter((r) => r === "held")).toHaveLength(2)
    expect(await c.claimShopCharge("233551234567")).toBe("claimed")
  })

  it("is SET NX with a TTL that outlives the webhook route's maxDuration", async () => {
    // Read from the route file's text: importing the route would load the whole webhook. Raising maxDuration past the
    // TTL fails here, because a claim could then expire under the request still charging.
    const route = readFileSync(resolve(process.cwd(), "app/api/whatsapp/webhook/route.ts"), "utf8")
    const match = route.match(/^export const maxDuration = (\d+)$/m)
    expect(match, "the webhook route must declare maxDuration").not.toBeNull()
    const maxDuration = Number(match![1])

    const c = await load(true)
    await c.claimShopCharge(SENDER)
    const [key, , opts] = h.setCalls[0]
    expect(key).toContain(SENDER)
    expect(opts.nx).toBe(true)
    expect(opts.ex).toBeGreaterThan(maxDuration)
    expect(opts.ex).toBeLessThanOrEqual(120)
  })

  it("release frees it for a later purchase", async () => {
    const c = await load(true)
    await c.claimShopCharge(SENDER)
    await c.releaseShopCharge(SENDER)
    expect(await c.claimShopCharge(SENDER)).toBe("claimed")
  })

  it("a Redis error is unavailable, never claimed", async () => {
    const c = await load(true)
    h.setFails = true
    expect(await c.claimShopCharge(SENDER)).toBe("unavailable")
  })

  it("a client that failed to initialise is unavailable, not the in-process path", async () => {
    h.ctorFails = true
    const c = await load(true)
    expect(await c.claimShopCharge(SENDER)).toBe("unavailable")
  })

  it("a failed release never throws", async () => {
    const c = await load(true)
    await c.claimShopCharge(SENDER)
    h.delFails = true
    await expect(c.releaseShopCharge(SENDER)).resolves.toBeUndefined()
  })
})

describe("outage alerting", () => {
  it("a Redis error raises one throttled admin alert, with no sender number in it", async () => {
    const c = await load(true)
    h.setFails = true
    await c.claimShopCharge(SENDER)
    await c.claimShopCharge(SENDER)
    expect(alertMock).toHaveBeenCalledTimes(2) // the throttle itself (sendThrottledAlert) limits delivery
    const [, message, opts] = alertMock.mock.calls[0]
    expect(message).not.toContain(SENDER)
    expect(message).not.toContain("244123456")
    expect(opts).toMatchObject({ key: expect.any(String), windowMs: expect.any(Number) })
    expect(opts.windowMs).toBeGreaterThanOrEqual(15 * 60_000)
  })

  it("a client that failed to initialise alerts too", async () => {
    h.ctorFails = true
    const c = await load(true)
    await c.claimShopCharge(SENDER)
    expect(alertMock).toHaveBeenCalledTimes(1)
  })

  it("an alert that throws never changes the answer", async () => {
    alertMock.mockRejectedValueOnce(new Error("x"))
    const c = await load(true)
    h.setFails = true
    expect(await c.claimShopCharge(SENDER)).toBe("unavailable")
  })

  it("no alert on a normal claim; a warning (not an alert) when Redis isn't configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const c = await load(true)
    await c.claimShopCharge(SENDER)
    expect(alertMock).not.toHaveBeenCalled()
    const u = await load(false)
    await u.claimShopCharge(SENDER)
    expect(alertMock).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not configured/))
  })
})

describe("with Redis not configured", () => {
  it("claims in-process, one at a time, and expires", async () => {
    const c = await load(false)
    expect(h.setCalls).toHaveLength(0)
    expect(await c.claimShopCharge(SENDER)).toBe("claimed")
    expect(await c.claimShopCharge(SENDER)).toBe("held")
    await c.releaseShopCharge(SENDER)
    expect(await c.claimShopCharge(SENDER)).toBe("claimed")
    const now = Date.now()
    const spy = vi.spyOn(Date, "now").mockReturnValue(now + 10 * 60 * 1000)
    expect(await c.claimShopCharge(SENDER)).toBe("claimed")
    spy.mockRestore()
  })
})
