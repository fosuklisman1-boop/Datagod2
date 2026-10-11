import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  primary: "hubtel", hubtelCfg: {} as unknown, balance: { ok: true, amountGhs: 35 } as any,
  observed: null as number | null, observedError: null as unknown, moolre: 900,
  alerts: [] as { type: string; message: string }[],
  routingThrows: false,
  backlog: 0 as unknown, backlogError: null as unknown,
  calls: [] as { m: string; args: unknown[] }[],
  queries: 0, lowThreshold: 50,
}))
vi.mock("./routing", () => ({
  getRoutingConfig: () => (h.routingThrows ? Promise.reject(new Error("db down")) : Promise.resolve({ primary: h.primary, fallbacks: [] })),
}))
vi.mock("./providers/hubtel", () => ({ hubtelConfigFromEnv: () => h.hubtelCfg }))
vi.mock("@/lib/ussd-hubtel/relay", () => ({ fetchDisbursementBalance: () => Promise.resolve(h.balance) }))
vi.mock("@/lib/sms-service", () => ({ queryMoolreSmsBalance: () => Promise.resolve(h.moolre) }))
vi.mock("./platform-settings", () => ({ loadSmsSettings: () => Promise.resolve({ hubtelCostPerSms: 0.035, hubtelLowBalanceGhs: h.lowThreshold }) }))
vi.mock("./notify", () => ({
  notifyAdminsThrottled: (type: string, _t: string, message: string) => { h.alerts.push({ type, message }); return Promise.resolve() },
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: (name: string) => {
      h.calls.push({ m: "rpc", args: [name] })
      return Promise.resolve({ data: h.backlog, error: h.backlogError })
    },
    from: () => {
      h.queries++
      const rec = (m: string, q: any) => (...args: unknown[]) => { h.calls.push({ m, args }); return q }
      const q: any = {}
      for (const m of ["select", "eq", "not", "gte", "order", "limit"]) q[m] = rec(m, q)
      q.maybeSingle = () => Promise.resolve({
        data: h.observed === null ? null : { cost_ghs: h.observed },
        error: h.observedError,
      })
      return q
    },
  }),
}))

import { backedCredits, getWholesaleCredits, resetObservedRateCache, composeHubtelSnapshot, getWholesaleSnapshot } from "./wholesale"

beforeEach(() => {
  h.primary = "hubtel"; h.hubtelCfg = {}; h.balance = { ok: true, amountGhs: 35 }; h.observed = null
  h.observedError = null; h.routingThrows = false; h.alerts = []; h.backlog = 0; h.backlogError = null
  h.calls = []; h.queries = 0; h.lowThreshold = 50
  resetObservedRateCache()
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
  it("queries the 7-day max Hubtel rate with the right filters", async () => {
    const before = Date.now()
    await getWholesaleCredits()
    const find = (m: string) => h.calls.filter(c => c.m === m)
    expect(find("eq").map(c => c.args)).toContainEqual(["provider", "hubtel"])
    expect(find("not").map(c => c.args)).toContainEqual(["cost_ghs", "is", null])
    const gte = find("gte")[0].args as [string, string]
    expect(gte[0]).toBe("processed_at")
    const since = new Date(gte[1]).getTime()
    expect(Math.abs(before - 7 * 86_400_000 - since)).toBeLessThan(5_000)
    expect(find("order")[0].args).toEqual(["cost_ghs", { ascending: false }])
    expect(find("limit")[0].args).toEqual([1])
  })
  it("subtracts the queued-unsent backlog", async () => {
    h.backlog = 300
    expect(await getWholesaleCredits()).toBe(700)
    expect(h.calls).toContainEqual({ m: "rpc", args: ["sms_queued_unsent_units"] })
  })
  it("accepts a bigint-as-string backlog", async () => {
    h.backlog = "300"
    expect(await getWholesaleCredits()).toBe(700)
  })
  it("never goes negative when the backlog exceeds supply", async () => {
    h.backlog = 5000
    expect(await getWholesaleCredits()).toBe(0)
  })
  it("fails closed when the backlog RPC errors", async () => {
    h.backlogError = { message: "boom" }
    expect(await getWholesaleCredits()).toBe(0)
  })
  it("fails closed when the backlog value is not a number", async () => {
    h.backlog = null
    expect(await getWholesaleCredits()).toBe(0)
  })
  it("fails closed and alerts when the balance can't be read", async () => {
    h.balance = { ok: false, error: "x" }
    expect(await getWholesaleCredits()).toBe(0)
    const a = h.alerts.find(x => x.type === "sms_hubtel_balance_unavailable")
    expect(a?.message).toContain("SMS credit sales are paused: x")
  })
  it("fails closed when the observed-rate lookup errors", async () => {
    h.observedError = { message: "timeout" }
    expect(await getWholesaleCredits()).toBe(0)
  })
  it("caches the observed rate for 5 minutes (one query for two calls)", async () => {
    await getWholesaleCredits()
    await getWholesaleCredits()
    expect(h.queries).toBe(1)
  })
  it("does not cache a failed lookup", async () => {
    h.observedError = { message: "timeout" }
    await getWholesaleCredits()
    h.observedError = null
    expect(await getWholesaleCredits()).toBe(1000)
    expect(h.queries).toBe(2)
  })
  it("alerts below the low-balance threshold", async () => {
    await getWholesaleCredits()
    expect(h.alerts.map(a => a.type)).toContain("sms_hubtel_low_balance")
  })
  it("alerts on a zero balance even if the threshold were 0", async () => {
    h.lowThreshold = 0
    h.balance = { ok: true, amountGhs: 0 }
    expect(await getWholesaleCredits()).toBe(0)
    expect(h.alerts.map(a => a.type)).toContain("sms_hubtel_low_balance")
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
  it("moolre path subtracts the queued backlog", async () => {
    h.primary = "moolre"; h.backlog = 250
    expect(await getWholesaleCredits()).toBe(650)
  })
  it("moolre path: backlog above supply gives 0", async () => {
    h.primary = "moolre"; h.backlog = 5000
    expect(await getWholesaleCredits()).toBe(0)
  })
  it("moolre path: backlog error fails closed", async () => {
    h.primary = "moolre"; h.backlogError = { message: "boom" }
    expect(await getWholesaleCredits()).toBe(0)
  })
  it("alerts admins when the supply lookup fails outright", async () => {
    h.backlogError = { message: "boom" }
    expect(await getWholesaleCredits()).toBe(0)
    const a = h.alerts.find(x => x.type === "sms_wholesale_supply_unknown")
    expect(a?.message).toContain("SMS credit sales are paused: backlog lookup failed: boom")
  })
  it("routing fell back to moolre: uses the Moolre balance, no Hubtel calls", async () => {
    h.primary = "moolre"; h.balance = { ok: false, error: "x" }
    expect(await getWholesaleCredits()).toBe(900)
    expect(h.alerts).toEqual([])
  })
  it("hubtel primary but not configured: falls back to Moolre credits", async () => {
    h.hubtelCfg = null
    expect(await getWholesaleCredits()).toBe(900)
  })
  it("fails closed if routing itself throws", async () => {
    h.routingThrows = true
    expect(await getWholesaleCredits()).toBe(0)
  })
})

describe("composeHubtelSnapshot (pure)", () => {
  it("backed = floor(balance/rate) − queued", () => {
    expect(composeHubtelSnapshot({ balance: { ok: true, amountGhs: 35 }, rate: 0.035, queued: 300 }))
      .toEqual({ provider: "hubtel", backedCredits: 700, balanceGhs: 35, ratePerSms: 0.035, queuedUnsent: 300 })
  })
  it("never negative", () => {
    expect(composeHubtelSnapshot({ balance: { ok: true, amountGhs: 1 }, rate: 0.035, queued: 500 }).backedCredits).toBe(0)
  })
  it("balance unreadable → 0 with the reason", () => {
    const s = composeHubtelSnapshot({ balance: { ok: false, error: "relay not configured" }, rate: 0.035, queued: 0 })
    expect(s).toMatchObject({ backedCredits: 0, balanceGhs: null, error: "Hubtel balance unavailable: relay not configured" })
  })
  it("queued backlog unknown → 0 with the reason", () => {
    const s = composeHubtelSnapshot({ balance: { ok: true, amountGhs: 35 }, rate: 0.035, queued: null })
    expect(s).toMatchObject({ backedCredits: 0, queuedUnsent: null, error: "Queued-message count unavailable" })
  })
})

describe("getWholesaleSnapshot", () => {
  it("moolre primary → moolre balance minus queued, provider moolre", async () => {
    h.primary = "moolre"; h.moolre = 900; h.backlog = 250
    expect(await getWholesaleSnapshot()).toMatchObject({ provider: "moolre", backedCredits: 650, balanceGhs: null, queuedUnsent: 250 })
  })
  it("never throws: a failing source yields backedCredits 0 and an error", async () => {
    h.primary = "moolre"; h.backlog = "boom" as any
    const s = await getWholesaleSnapshot()
    expect(s.backedCredits).toBe(0)
    expect(s.error).toBeTruthy()
  })
})
