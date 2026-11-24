import { describe, it, expect, vi } from "vitest"
import { createMoneySettings, reserveSpend, settleSpend, capMessage, spendGuard, MONEY_SETTINGS_TTL_MS } from "./spend"
import type { V2Context } from "./handler"

type Res = { data: unknown; error: unknown }
function settingsClient(src: () => Res | Promise<Res>) {
  let calls = 0
  const client = {
    from() {
      calls++
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => chain,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        then: (a: any, b: any) => Promise.resolve().then(src).then(a, b),
      }
      return chain
    },
  }
  return { client, calls: () => calls }
}
const row = (caps: boolean, alerts = false): Res => ({ data: { caps_enabled: caps, alerts_enabled: alerts }, error: null })

function rpcClient(res: Res | (() => never)) {
  const rpc = vi.fn(async () => (typeof res === "function" ? res() : res))
  return { rpc, client: { rpc, from: () => { throw new Error("no from") } } as never }
}

const ctx = (env: "live" | "test"): V2Context => ({ keyId: "k1", userId: "u1", role: "dealer", keyType: "standard", environment: env, firstName: null })

describe("money settings snapshot", () => {
  it("missing table (42P01/PGRST205) -> caps off, alerts off, cached for 10 s; any other error -> keep the last snapshot; no snapshot yet -> caps off (the dark default)", async () => {
    let t = 1_000_000
    for (const code of ["42P01", "PGRST205"]) {
      const f = settingsClient(() => ({ data: null, error: { code } }))
      const s = createMoneySettings({ client: f.client, now: () => t })
      expect(await s.read()).toMatchObject({ capsEnabled: false, alertsEnabled: false })
      await s.read()
      expect(f.calls()).toBe(1)
    }
    let mode: "on" | "err" = "on"
    const f = settingsClient(() => (mode === "on" ? row(true, true) : { data: null, error: { code: "57014" } }))
    const s = createMoneySettings({ client: f.client, now: () => t })
    expect(await s.read()).toMatchObject({ capsEnabled: true, alertsEnabled: true })
    mode = "err"
    t += MONEY_SETTINGS_TTL_MS + 1
    expect(await s.read()).toMatchObject({ capsEnabled: true })
    const fresh = settingsClient(() => ({ data: null, error: { code: "57014" } }))
    expect(await createMoneySettings({ client: fresh.client, now: () => t }).read()).toMatchObject({ capsEnabled: false })
  })

  it("second read inside 10 s makes zero client calls; invalidate() forces a read", async () => {
    let t = 5_000
    const f = settingsClient(() => row(true))
    const s = createMoneySettings({ client: f.client, now: () => t })
    await s.read()
    t += MONEY_SETTINGS_TTL_MS - 1
    await s.read()
    expect(f.calls()).toBe(1)
    s.invalidate()
    await s.read()
    expect(f.calls()).toBe(2)
    expect(MONEY_SETTINGS_TTL_MS).toBe(10_000)
  })

  it("a thrown client call never throws out of read()", async () => {
    const f = settingsClient(() => {
      throw new Error("boom")
    })
    await expect(createMoneySettings({ client: f.client, now: () => 1 }).read()).resolves.toMatchObject({ capsEnabled: false })
  })
})

describe("reserveSpend / settleSpend", () => {
  const p = { userId: "u1", keyId: "k1", kind: "airtime" as const, reference: "ref-1", amount: 12.5 }
  it("maps skipped, reserved, cap with scope, and rpc error/throw/bad_input to error", async () => {
    expect(await reserveSpend(rpcClient({ data: { ok: true, skipped: true }, error: null }).client, p)).toEqual({ kind: "skipped" })
    expect(await reserveSpend(rpcClient({ data: { ok: true, ledger_id: "L" }, error: null }).client, p)).toEqual({ kind: "reserved" })
    expect(await reserveSpend(rpcClient({ data: { ok: false, code: "cap_reached", scope: "user" }, error: null }).client, p)).toEqual({ kind: "cap", scope: "user" })
    expect(await reserveSpend(rpcClient({ data: { ok: false, code: "cap_reached", scope: "key" }, error: null }).client, p)).toEqual({ kind: "cap", scope: "key" })
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await reserveSpend(rpcClient({ data: null, error: { code: "57014", message: "timeout" } }).client, p)).toEqual({ kind: "error" })
    expect(await reserveSpend(rpcClient({ data: { ok: false, code: "bad_input" }, error: null }).client, p)).toEqual({ kind: "error" })
    expect(await reserveSpend(rpcClient(() => { throw new Error("x") }).client, p)).toEqual({ kind: "error" })
    spy.mockRestore()
  })
  it("passes the exact rpc arguments", async () => {
    const r = rpcClient({ data: { ok: true, ledger_id: "L" }, error: null })
    await reserveSpend(r.client, p)
    expect(r.rpc).toHaveBeenCalledWith("api_v2_spend_reserve", { p_user: "u1", p_key: "k1", p_kind: "airtime", p_reference: "ref-1", p_amount: 12.5 })
    const s = rpcClient({ data: { ok: true, changed: true }, error: null })
    await settleSpend(s.client, { keyId: "k1", kind: "data_bulk", reference: "b", state: "spent", amount: 4 })
    expect(s.rpc).toHaveBeenCalledWith("api_v2_spend_settle", { p_key: "k1", p_kind: "data_bulk", p_reference: "b", p_state: "spent", p_amount: 4 })
  })
  it("settleSpend swallows errors and logs only the function name and code", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(settleSpend(rpcClient({ data: null, error: { code: "57014", message: "secret detail" } }).client, { keyId: "k", kind: "data", reference: "r", state: "released" })).resolves.toBeUndefined()
    await expect(settleSpend(rpcClient(() => { throw new Error("secret") }).client, { keyId: "k", kind: "data", reference: "r", state: "released" })).resolves.toBeUndefined()
    const logged = JSON.stringify(spy.mock.calls)
    expect(logged).toContain("api_v2_spend_settle")
    expect(logged).not.toContain("secret")
    spy.mockRestore()
  })
})

describe("capMessage / spendGuard", () => {
  it("capMessage('key') starts with the code and names 00:00 GMT; capMessage('user') adds the Datagod line and no digits beyond the time", () => {
    const k = capMessage("key")
    expect(k.startsWith("DAILY_LIMIT_REACHED: ")).toBe(true)
    expect(k).toContain("00:00 GMT")
    const u = capMessage("user")
    expect(u.startsWith("DAILY_LIMIT_REACHED: ")).toBe(true)
    expect(u).toContain("A Datagod limit applies.")
    expect(u.replace("00:00", "")).not.toMatch(/\d/)
  })
  it("spendGuard: test key -> false; live key with caps off -> false; live with caps on -> true", () => {
    const on = { capsEnabled: true, alertsEnabled: false, at: 0 }
    const off = { capsEnabled: false, alertsEnabled: false, at: 0 }
    expect(spendGuard(ctx("test"), on)).toBe(false)
    expect(spendGuard(ctx("live"), off)).toBe(false)
    expect(spendGuard(ctx("live"), on)).toBe(true)
  })
})
