import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  primary: "hubtel", hubtelCfg: {} as unknown, balance: { ok: true, amountGhs: 35 } as any,
  observed: null as number | null, observedError: null as unknown, moolre: 900, alerts: [] as string[],
  routingThrows: false,
}))
vi.mock("./routing", () => ({
  getRoutingConfig: () => (h.routingThrows ? Promise.reject(new Error("db down")) : Promise.resolve({ primary: h.primary, fallbacks: [] })),
}))
vi.mock("./providers/hubtel", () => ({ hubtelConfigFromEnv: () => h.hubtelCfg }))
vi.mock("@/lib/ussd-hubtel/relay", () => ({ fetchDisbursementBalance: () => Promise.resolve(h.balance) }))
vi.mock("@/lib/sms-service", () => ({ queryMoolreSmsBalance: () => Promise.resolve(h.moolre) }))
vi.mock("./platform-settings", () => ({ loadSmsSettings: () => Promise.resolve({ hubtelCostPerSms: 0.035, hubtelLowBalanceGhs: 50 }) }))
vi.mock("./notify", () => ({ notifyAdminsThrottled: (type: string) => { h.alerts.push(type); return Promise.resolve() } }))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => {
      const q: any = { select: () => q, eq: () => q, not: () => q, gte: () => q, order: () => q, limit: () => q,
        maybeSingle: () => Promise.resolve({
          data: h.observed === null ? null : { cost_ghs: h.observed },
          error: h.observedError,
        }) }
      return q
    },
  }),
}))

import { backedCredits, getWholesaleCredits } from "./wholesale"

beforeEach(() => {
  h.primary = "hubtel"; h.hubtelCfg = {}; h.balance = { ok: true, amountGhs: 35 }; h.observed = null
  h.observedError = null; h.routingThrows = false; h.alerts = []
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("backedCredits", () => {
  it("floors balance / cost", () => expect(backedCredits(35, 0.035)).toBe(1000))
  it("is 0 for bad input", () => {
    expect(backedCredits(-1, 0.03)).toBe(0)
    expect(backedCredits(10, 0)).toBe(0)
    expect(backedCredits(NaN, 0.03)).toBe(0)
  })
})

describe("getWholesaleCredits", () => {
  it("hubtel primary: balance ÷ fallback cost until rates are observed", async () => {
    expect(await getWholesaleCredits()).toBe(1000)
  })
  it("uses the highest observed rate when present", async () => {
    h.observed = 0.05
    expect(await getWholesaleCredits()).toBe(700)
  })
  it("fails closed when the balance can't be read", async () => {
    h.balance = { ok: false, error: "x" }
    expect(await getWholesaleCredits()).toBe(0)
  })
  it("fails closed when the observed-rate lookup errors", async () => {
    h.observedError = { message: "timeout" }
    expect(await getWholesaleCredits()).toBe(0)
  })
  it("fails closed when routing can't be loaded", async () => {
    h.routingThrows = true
    expect(await getWholesaleCredits()).toBe(0)
  })
  it("alerts below the low-balance threshold", async () => {
    await getWholesaleCredits()
    expect(h.alerts).toContain("sms_hubtel_low_balance")
  })
  it("does not alert at or above the threshold", async () => {
    h.balance = { ok: true, amountGhs: 80 }
    await getWholesaleCredits()
    expect(h.alerts).toEqual([])
  })
  it("moolre primary: Moolre wholesale credits", async () => {
    h.primary = "moolre"
    expect(await getWholesaleCredits()).toBe(900)
  })
  it("hubtel primary but not configured: falls back to Moolre credits", async () => {
    h.hubtelCfg = null
    expect(await getWholesaleCredits()).toBe(900)
  })
})
