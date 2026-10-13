import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  primary: "hubtel", hubtelCfg: {} as unknown, balance: { ok: true, amountGhs: 35 } as any,
  observed: null as number | null, observedError: null as unknown, moolre: 900,
  alerts: [] as { type: string; message: string }[],
  routingThrows: false,
  backlog: 0 as unknown, backlogError: null as unknown,
  calls: [] as { m: string; args: unknown[] }[],
  queries: 0, lowThreshold: 50,
  manual: null as null | { amountGhs: number; setAt: string; setBy: string },
  spend: 0 as unknown, spendError: null as unknown,
  failRateQueryNo: null as number | null,
  prefer: false, relayCalls: 0,
  settingsError: null as unknown, settingsReads: 0,
}))
vi.mock("./routing", () => ({
  getRoutingConfig: () => (h.routingThrows ? Promise.reject(new Error("db down")) : Promise.resolve({ primary: h.primary, fallbacks: [] })),
}))
vi.mock("./providers/hubtel", () => ({ hubtelConfigFromEnv: () => h.hubtelCfg }))
vi.mock("@/lib/ussd-hubtel/relay", () => ({ fetchDisbursementBalance: () => { h.relayCalls++; return Promise.resolve(h.balance) } }))
vi.mock("@/lib/sms-service", () => ({ queryMoolreSmsBalance: () => Promise.resolve(h.moolre) }))
// loadSmsSettings (cached, tolerant) is stubbed; loadHubtelBalanceSettings is the REAL strict loader,
// reading tenant_global_settings through the Supabase mock below (h.prefer / h.manual / h.settingsError).
vi.mock("./platform-settings", async (orig) => ({
  ...(await orig<typeof import("./platform-settings")>()),
  loadSmsSettings: () => Promise.resolve({ hubtelCostPerSms: 0.035, hubtelLowBalanceGhs: h.lowThreshold, hubtelManualBalance: null, hubtelPreferManualBalance: false }),
}))
vi.mock("./notify", () => ({
  notifyAdminsThrottled: (type: string, _t: string, message: string) => { h.alerts.push({ type, message }); return Promise.resolve() },
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: (name: string, params?: unknown) => {
      if (name === "sms_hubtel_max_rate") {
        h.queries++
        h.calls.push({ m: "rpc", args: [name, params] })
        const n = h.queries
        return Promise.resolve({
          data: h.observed,
          error: h.failRateQueryNo === n ? { message: "timeout" } : h.observedError,
        })
      }
      if (name === "sms_hubtel_spend_since") {
        h.calls.push({ m: "rpc", args: [name, params] })
        return Promise.resolve({ data: h.spend, error: h.spendError })
      }
      h.calls.push({ m: "rpc", args: [name] })
      return Promise.resolve({ data: h.backlog, error: h.backlogError })
    },
    from: (table: string) => {
      if (table === "tenant_global_settings") {
        h.settingsReads++
        const rows = [
          { key: "sms_hubtel_prefer_manual_balance", value: h.prefer },
          ...(h.manual ? [{ key: "sms_hubtel_manual_balance", value: h.manual }] : []),
          { key: "sms_hubtel_cost_per_sms", value: 0.035 },
        ]
        return { select: () => ({ in: () => Promise.resolve(h.settingsError ? { data: null, error: h.settingsError } : { data: rows, error: null }) }) }
      }
      throw new Error(`unexpected table read: ${table}`)
    },
  }),
}))

import { backedCredits, getWholesaleCredits, resetObservedRateCache, composeHubtelSnapshot, getWholesaleSnapshot, resolveHubtelBalance } from "./wholesale"

const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString()
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

beforeEach(() => {
  h.primary = "hubtel"; h.hubtelCfg = {}; h.balance = { ok: true, amountGhs: 35 }; h.observed = null
  h.observedError = null; h.routingThrows = false; h.alerts = []; h.backlog = 0; h.backlogError = null
  h.calls = []; h.queries = 0; h.lowThreshold = 50
  h.manual = null; h.spend = 0; h.spendError = null; h.failRateQueryNo = null; h.prefer = false; h.relayCalls = 0
  h.settingsError = null; h.settingsReads = 0
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
  it("gets the 7-day max PER-SEGMENT Hubtel rate from sms_hubtel_max_rate", async () => {
    await getWholesaleCredits()
    expect(h.calls).toContainEqual({ m: "rpc", args: ["sms_hubtel_max_rate", { p_days: 7 }] })
  })
  it("per-segment rate: a 2-part message reported at GH₵0.0486 → 0.0243/part, so 35 GH₵ backs 1440 parts", async () => {
    h.observed = 0.0243 // what sms_hubtel_max_rate returns for cost_ghs 0.0486 / segments 2
    expect(await getWholesaleCredits()).toBe(1440)
  })
  it("accepts the numeric-as-string PostgREST returns", async () => {
    h.observed = "0.0243" as any
    expect(await getWholesaleCredits()).toBe(1440)
  })
  it("a non-positive or garbage rate counts as 'nothing observed' (configured cost used)", async () => {
    h.observed = 0 as any
    expect(await getWholesaleCredits()).toBe(1000)
    resetObservedRateCache(); h.observed = "abc" as any
    expect(await getWholesaleCredits()).toBe(1000)
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
  it("hubtel live path: observed rate preferred over the settings cost", async () => {
    h.observed = 0.05
    expect(await getWholesaleSnapshot()).toEqual({ provider: "hubtel", backedCredits: 700, balanceGhs: 35, ratePerSms: 0.05, queuedUnsent: 0, balanceSource: "relay" })
  })
  it("hubtel live path: rate lookup failure → 0 with 'Rate lookup failed'", async () => {
    h.observedError = { message: "timeout" }
    const s = await getWholesaleSnapshot()
    expect(s.backedCredits).toBe(0)
    expect(s.error).toContain("Rate lookup failed")
    expect(s.error).toContain("timeout")
    expect(s.ratePerSms).toBe(0.035)
  })
  it("hubtel live path: unreadable balance keeps the balance error even if the rate also fails", async () => {
    h.observedError = { message: "timeout" }; h.balance = { ok: false, error: "relay down" }
    expect((await getWholesaleSnapshot()).error).toContain("Hubtel balance unavailable: relay down")
  })
  it("primary hubtel but not configured → moolre branch", async () => {
    h.hubtelCfg = null; h.moolre = 900; h.backlog = 250
    expect(await getWholesaleSnapshot()).toMatchObject({ provider: "moolre", backedCredits: 650 })
  })
  it("never throws: a failing source yields backedCredits 0 and an error", async () => {
    h.primary = "moolre"; h.backlog = "boom" as any
    const s = await getWholesaleSnapshot()
    expect(s.backedCredits).toBe(0)
    expect(s.error).toBeTruthy()
  })
})

describe("resolveHubtelBalance", () => {
  it("relay works → relay balance, no manual lookup (the real balance always wins)", async () => {
    h.manual = { amountGhs: 999, setAt: hoursAgo(1), setBy: "a" }
    expect(await resolveHubtelBalance()).toEqual({ ok: true, amountGhs: 35, source: "relay" })
    expect(h.calls.some(c => c.args[0] === "sms_hubtel_spend_since")).toBe(false)
  })
  it("relay fails, no manual balance → unavailable with the relay error (today's behaviour)", async () => {
    h.balance = { ok: false, error: "relay/hubtel 403" }
    expect(await resolveHubtelBalance()).toEqual({ ok: false, error: "relay/hubtel 403" })
  })
  it("relay fails, fresh manual → amount − spend since setAt, source manual", async () => {
    h.balance = { ok: false, error: "403" }
    const setAt = hoursAgo(3)
    h.manual = { amountGhs: 100, setAt, setBy: "a" }; h.spend = "12.5"
    expect(await resolveHubtelBalance()).toEqual({ ok: true, amountGhs: 87.5, source: "manual", manualSetAt: setAt })
    expect(h.calls).toContainEqual({ m: "rpc", args: ["sms_hubtel_spend_since", { p_since: setAt, p_default_rate: 0.035 }] })
  })
  it("default rate for unknown costs = the highest observed rate when one exists", async () => {
    h.balance = { ok: false, error: "403" }; h.observed = 0.05
    h.manual = { amountGhs: 100, setAt: hoursAgo(3), setBy: "a" }
    await resolveHubtelBalance()
    const call = h.calls.find(c => c.args[0] === "sms_hubtel_spend_since")
    expect((call?.args[1] as { p_default_rate: number }).p_default_rate).toBe(0.05)
  })
  it("estimate is floored at 0", async () => {
    h.balance = { ok: false, error: "403" }
    h.manual = { amountGhs: 10, setAt: hoursAgo(3), setBy: "a" }; h.spend = 40
    expect(await resolveHubtelBalance()).toMatchObject({ ok: true, amountGhs: 0, source: "manual" })
  })
  it("manual older than 30 days is ignored → unavailable, says why", async () => {
    h.balance = { ok: false, error: "403" }
    h.manual = { amountGhs: 100, setAt: daysAgo(31), setBy: "a" }
    const r = await resolveHubtelBalance()
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/^403.*older than 30 days/)
    expect(h.calls.some(c => c.args[0] === "sms_hubtel_spend_since")).toBe(false)
  })
  it("spend query error → fails CLOSED (unavailable), never 'nothing spent'", async () => {
    h.balance = { ok: false, error: "403" }
    h.manual = { amountGhs: 100, setAt: hoursAgo(3), setBy: "a" }; h.spendError = { message: "function does not exist" }
    const r = await resolveHubtelBalance()
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain("function does not exist")
  })
  it.each([[null], [undefined], ["abc"], [-3]])("spend value %s → fails closed", async (spend) => {
    h.balance = { ok: false, error: "403" }
    h.manual = { amountGhs: 100, setAt: hoursAgo(3), setBy: "a" }; h.spend = spend
    expect((await resolveHubtelBalance()).ok).toBe(false)
  })
  it("observed-rate lookup error → fails closed (no possibly-lower rate)", async () => {
    h.balance = { ok: false, error: "403" }; h.observedError = { message: "timeout" }
    h.manual = { amountGhs: 100, setAt: hoursAgo(3), setBy: "a" }
    expect((await resolveHubtelBalance()).ok).toBe(false)
    expect(h.calls.some(c => c.args[0] === "sms_hubtel_spend_since")).toBe(false)
  })
})

describe("getWholesaleCredits with a manual balance", () => {
  it("relay down + fresh manual → credits from the estimate minus the backlog, no 'unavailable' alert", async () => {
    h.balance = { ok: false, error: "403" }; h.lowThreshold = 0
    h.manual = { amountGhs: 40, setAt: hoursAgo(2), setBy: "a" }; h.spend = 5; h.backlog = 100
    expect(await getWholesaleCredits()).toBe(900) // floor(35 / 0.035) − 100
    expect(h.alerts.map(a => a.type)).not.toContain("sms_hubtel_balance_unavailable")
  })
  it("relay down + spend query fails → 0 and alerts", async () => {
    h.balance = { ok: false, error: "403" }
    h.manual = { amountGhs: 40, setAt: hoursAgo(2), setBy: "a" }; h.spendError = { message: "boom" }
    expect(await getWholesaleCredits()).toBe(0)
    expect(h.alerts.map(a => a.type)).toContain("sms_hubtel_balance_unavailable")
  })
  it("relay down + stale manual → 0", async () => {
    h.balance = { ok: false, error: "403" }
    h.manual = { amountGhs: 40, setAt: daysAgo(45), setBy: "a" }
    expect(await getWholesaleCredits()).toBe(0)
  })
  it("relay up wins over the manual balance", async () => {
    h.manual = { amountGhs: 1, setAt: hoursAgo(2), setBy: "a" }
    expect(await getWholesaleCredits()).toBe(1000)
  })
  it("the unavailable alert mentions the manual fallback option", async () => {
    h.balance = { ok: false, error: "x" }
    await getWholesaleCredits()
    expect(h.alerts.find(a => a.type === "sms_hubtel_balance_unavailable")?.message).toMatch(/manual Hubtel balance/i)
  })
  it("low-balance alert on a manual estimate says it is an estimate", async () => {
    h.balance = { ok: false, error: "403" }
    h.manual = { amountGhs: 10, setAt: hoursAgo(2), setBy: "a" }
    await getWholesaleCredits()
    const m = h.alerts.find(a => a.type === "sms_hubtel_low_balance")?.message ?? ""
    expect(m).toMatch(/estimate/i)
    expect(m).toMatch(/Hubtel SMS balance/)
    expect(m).toMatch(/Top up the Hubtel SMS wallet/)
    expect(m).not.toMatch(/Disbursement/)
  })
})

describe("getWholesaleSnapshot with a manual balance", () => {
  it("relay down + fresh manual → hubtel snapshot from the estimate, balanceSource manual + setAt", async () => {
    h.balance = { ok: false, error: "403" }
    const setAt = hoursAgo(2)
    h.manual = { amountGhs: 40, setAt, setBy: "a" }; h.spend = 5; h.backlog = 100
    expect(await getWholesaleSnapshot()).toEqual({
      provider: "hubtel", backedCredits: 900, balanceGhs: 35, ratePerSms: 0.035, queuedUnsent: 100,
      balanceSource: "manual", manualSetAt: setAt,
    })
  })
  it("snapshot rate-lookup failure on a manual estimate keeps balanceSource + manualSetAt", async () => {
    h.balance = { ok: false, error: "403" }
    const setAt = hoursAgo(2)
    h.manual = { amountGhs: 40, setAt, setBy: "a" }; h.spend = 5
    // The snapshot's own rate lookup (query #1) fails; resolveHubtelBalance's (query #2) succeeds.
    h.failRateQueryNo = 1
    const s = await getWholesaleSnapshot()
    expect(s).toMatchObject({ provider: "hubtel", backedCredits: 0, balanceGhs: 35, balanceSource: "manual", manualSetAt: setAt })
    expect(s.error).toContain("Rate lookup failed")
  })
  it("prefer=true: snapshot uses the manual estimate (marked preferred) even though the relay works", async () => {
    h.prefer = true; h.balance = { ok: true, amountGhs: 0 }
    const setAt = hoursAgo(2)
    h.manual = { amountGhs: 40, setAt, setBy: "a" }; h.spend = 5
    expect(await getWholesaleSnapshot()).toEqual({
      provider: "hubtel", backedCredits: 1000, balanceGhs: 35, ratePerSms: 0.035, queuedUnsent: 0,
      balanceSource: "manual", manualSetAt: setAt, manualPreferred: true,
    })
  })
  it("prefer=true + stale manual: snapshot is 0 with the 'preferred but missing' error, never the relay figure", async () => {
    h.prefer = true; h.balance = { ok: true, amountGhs: 500 }
    h.manual = { amountGhs: 40, setAt: daysAgo(31), setBy: "a" }
    const s = await getWholesaleSnapshot()
    expect(s).toMatchObject({ backedCredits: 0, balanceGhs: null })
    expect(s.error).toMatch(/manual balance preferred but missing or older than 30 days/)
  })
  it("relay down + spend failure → 0 with an error, no balanceSource", async () => {
    h.balance = { ok: false, error: "403" }
    h.manual = { amountGhs: 40, setAt: hoursAgo(2), setBy: "a" }; h.spendError = { message: "boom" }
    const s = await getWholesaleSnapshot()
    expect(s.backedCredits).toBe(0)
    expect(s.error).toContain("boom")
    expect(s.balanceSource).toBeUndefined()
  })
})

describe("prefer the manual balance (relay reads the wrong wallet)", () => {
  it("prefer + fresh manual → manual estimate, relay NOT called", async () => {
    h.prefer = true
    const setAt = hoursAgo(3)
    h.manual = { amountGhs: 100, setAt, setBy: "a" }; h.spend = 12.5
    expect(await resolveHubtelBalance()).toEqual({ ok: true, amountGhs: 87.5, source: "manual", manualSetAt: setAt, preferred: true })
    expect(h.relayCalls).toBe(0)
  })
  it("prefer + relay healthy but reading 0 → ignored; credits come from the manual estimate", async () => {
    h.prefer = true; h.balance = { ok: true, amountGhs: 0 }; h.lowThreshold = 0
    h.manual = { amountGhs: 40, setAt: hoursAgo(2), setBy: "a" }; h.spend = 5; h.backlog = 100
    expect(await getWholesaleCredits()).toBe(900)
    expect(h.relayCalls).toBe(0)
  })
  it("prefer + stale manual → unavailable with a clear error; the relay figure is never used", async () => {
    h.prefer = true; h.balance = { ok: true, amountGhs: 500 }
    h.manual = { amountGhs: 100, setAt: daysAgo(31), setBy: "a" }
    expect(await resolveHubtelBalance()).toEqual({ ok: false, error: expect.stringMatching(/^manual balance preferred but missing or older than 30 days/) })
    expect(h.relayCalls).toBe(0)
    expect(await getWholesaleCredits()).toBe(0)
  })
  it("prefer + stale manual: the alert points at the manual balance, not the relay", async () => {
    h.prefer = true
    h.manual = { amountGhs: 100, setAt: daysAgo(31), setBy: "a" }
    await getWholesaleCredits()
    const a = h.alerts.find(x => x.type === "sms_hubtel_balance_unavailable")?.message ?? ""
    expect(a).toMatch(/manual balance preferred/)
    expect(a).toMatch(/Hubtel balance \(manual fallback\)/)
    expect(a).not.toMatch(/IP whitelist/)
  })
  it("prefer + no manual balance → unavailable", async () => {
    h.prefer = true; h.balance = { ok: true, amountGhs: 500 }
    const r = await resolveHubtelBalance()
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/manual balance preferred but missing or older than 30 days/)
  })
  it("prefer + spend query fails → unavailable (fail closed), relay not used", async () => {
    h.prefer = true; h.balance = { ok: true, amountGhs: 500 }
    h.manual = { amountGhs: 100, setAt: hoursAgo(1), setBy: "a" }; h.spendError = { message: "boom" }
    const r = await resolveHubtelBalance()
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/manual balance preferred but its estimate is unavailable: .*boom/)
    expect(h.relayCalls).toBe(0)
  })
  it("prefer + rate lookup fails → unavailable", async () => {
    h.prefer = true; h.observedError = { message: "timeout" }
    h.manual = { amountGhs: 100, setAt: hoursAgo(1), setBy: "a" }
    expect((await resolveHubtelBalance()).ok).toBe(false)
  })
  it("settings read error (fresh instance, no cache) → unavailable, even though the relay works", async () => {
    h.settingsError = { message: "connection reset" }
    h.balance = { ok: true, amountGhs: 35 }
    const r = await resolveHubtelBalance()
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/connection reset/)
    expect(h.relayCalls).toBe(0)
    expect(await getWholesaleCredits()).toBe(0)
  })
  it("settings read error → snapshot backs 0 with the reason", async () => {
    h.settingsError = { message: "connection reset" }
    const s = await getWholesaleSnapshot()
    expect(s.backedCredits).toBe(0)
    expect(s.error).toMatch(/connection reset/)
  })
  it("an unreadable prefer flag → unavailable (never treated as off)", async () => {
    h.prefer = "yes" as any; h.manual = { amountGhs: 100, setAt: hoursAgo(1), setBy: "a" }
    expect((await resolveHubtelBalance()).ok).toBe(false)
    expect(h.relayCalls).toBe(0)
  })
  it("the strict settings are re-read on every check (no cache): toggling takes effect immediately", async () => {
    h.manual = { amountGhs: 100, setAt: hoursAgo(1), setBy: "a" }; h.spend = 0
    expect((await resolveHubtelBalance()).ok && (await resolveHubtelBalance() as any).source).toBe("relay")
    h.prefer = true
    expect(await resolveHubtelBalance()).toMatchObject({ ok: true, source: "manual", preferred: true })
  })
  it("Moolre primary never reads the strict Hubtel settings", async () => {
    h.primary = "moolre"; h.settingsError = { message: "down" }
    expect(await getWholesaleCredits()).toBe(900)
    expect((await getWholesaleSnapshot()).backedCredits).toBe(900)
    expect(h.settingsReads).toBe(0)
  })
  it("prefer=false is unchanged: relay wins over a fresh manual balance", async () => {
    h.manual = { amountGhs: 1, setAt: hoursAgo(1), setBy: "a" }
    expect(await resolveHubtelBalance()).toEqual({ ok: true, amountGhs: 35, source: "relay" })
    expect(h.relayCalls).toBe(1)
  })
  it("prefer=false + relay down → manual fallback result has no 'preferred' marker", async () => {
    h.balance = { ok: false, error: "403" }
    const setAt = hoursAgo(1)
    h.manual = { amountGhs: 10, setAt, setBy: "a" }
    expect(await resolveHubtelBalance()).toEqual({ ok: true, amountGhs: 10, source: "manual", manualSetAt: setAt })
  })
})
