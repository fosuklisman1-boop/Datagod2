import { describe, expect, it } from "vitest"
import { BILLS_CONFIG_KEY, checkBillAmount, resolveBillsConfig, setBillsConfig, validateBillsPatch } from "./config"

describe("bills config", () => {
  it("key", () => expect(BILLS_CONFIG_KEY).toBe("utility_bills_config"))
  it("ships dark: everything off with default limits", () => {
    const c = resolveBillsConfig(null)
    expect(c.enabled).toBe(false)
    expect(c.autoFulfil).toBe(true)
    for (const k of ["ecg", "ghana_water", "dstv", "gotv", "startimes", "telecel_broadband"] as const) {
      expect(c.billers[k]).toEqual({ enabled: false, min: 5, max: 10000 })
    }
  })
  it("only literal true enables; bad limits fall back to defaults", () => {
    const c = resolveBillsConfig({ enabled: "true", billers: { dstv: { enabled: true, min: 0, max: 99999 }, gotv: { enabled: true, min: 20, max: 500 } } })
    expect(c.enabled).toBe(false)
    expect(c.billers.dstv).toEqual({ enabled: true, min: 5, max: 10000 })
    expect(c.billers.gotv).toEqual({ enabled: true, min: 20, max: 500 })
  })
  it("validates patches strictly", () => {
    expect(validateBillsPatch({ enabled: true, autoFulfil: false })).toEqual({ ok: true, patch: { enabled: true, autoFulfil: false } })
    expect(validateBillsPatch({ billers: { ecg: { enabled: true, min: 10, max: 2000 } } }).ok).toBe(true)
    expect(validateBillsPatch({ nope: 1 }).ok).toBe(false)
    expect(validateBillsPatch({ billers: { ecg: { enabled: true, min: 50, max: 10 } } }).ok).toBe(false)
    expect(validateBillsPatch({ billers: { ecg: { enabled: true, min: 0, max: 10 } } }).ok).toBe(false)
    expect(validateBillsPatch({ billers: { ecg: { enabled: true, min: 5, max: 10001 } } }).ok).toBe(false)
    expect(validateBillsPatch({ billers: { ecg: { enabled: true } } }).ok).toBe(false)
    expect(validateBillsPatch({ billers: { water: { enabled: true, min: 5, max: 10 } } }).ok).toBe(false)
    expect(validateBillsPatch([]).ok).toBe(false)
  })
  it("amount limits", () => {
    const s = { enabled: true, min: 5, max: 100 }
    expect(checkBillAmount(s, 5)).toBeNull()
    expect(checkBillAmount(s, 100)).toBeNull()
    expect(checkBillAmount(s, 4.99)).toMatch(/at least/)
    expect(checkBillAmount(s, 100.01)).toMatch(/at most/)
    expect(checkBillAmount(s, 10.005)).toMatch(/decimal/)
    expect(checkBillAmount(s, NaN)).toMatch(/valid/)
  })
  it("setBillsConfig calls the RPC with the validated patch", async () => {
    const calls: any[] = []
    const db = { rpc: async (fn: string, args: any) => { calls.push({ fn, args }); return { data: { enabled: true }, error: null } } } as any
    const c = await setBillsConfig(db, { enabled: true })
    expect(calls).toEqual([{ fn: "utility_bills_config_patch", args: { p_patch: { enabled: true } } }])
    expect(c.enabled).toBe(true)
  })
})
