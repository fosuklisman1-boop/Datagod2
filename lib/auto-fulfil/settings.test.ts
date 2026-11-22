import { describe, it, expect } from "vitest"
import {
  AUTO_FULFIL_NETWORKS,
  AUTO_FULFIL_SETTINGS_KEY,
  DEFAULT_AUTO_FULFIL_SETTINGS,
  loadAutoFulfilSettings,
  parseAutoFulfilSettings,
} from "./settings"

const D = DEFAULT_AUTO_FULFIL_SETTINGS
const clone = () => JSON.parse(JSON.stringify(D))
const fakeDb = (result: { data: any; error: any }) =>
  ({
    from: (t: string) => {
      expect(t).toBe("admin_settings")
      return {
        select: () => ({
          eq: (col: string, val: string) => {
            expect(col).toBe("key")
            expect(val).toBe(AUTO_FULFIL_SETTINGS_KEY)
            return { maybeSingle: async () => result }
          },
        }),
      }
    },
  }) as any

describe("auto-fulfil settings", () => {
  it("defaults are off and match the spec table", () => {
    expect(D.enabled).toBe(false)
    expect(D.minAgeMinutes).toBe(10)
    expect(D.rules.rate_limited).toEqual({ retry: true, waitMinutes: 2, maxTries: 5 })
    expect(D.rules.not_enabled).toEqual({ retry: true, waitMinutes: 1440, maxTries: 3 })
    expect(D.rules.out_of_balance.waitMinutes).toBe(30)
    expect(D.rules.supplier_unavailable.waitMinutes).toBe(30)
    expect(D.rules.rejected.waitMinutes).toBe(60)
    expect(D.rules.no_bundle.retry).toBe(false)
    expect(D.rules.wrong_number.retry).toBe(false)
    expect(parseAutoFulfilSettings(D).ok).toBe(true)
  })

  it.each([9, 121, 10.5, "10"])("rejects minAgeMinutes %s", (v) =>
    expect(parseAutoFulfilSettings({ ...D, minAgeMinutes: v }).ok).toBe(false))

  it("rejects waits under 1 min or over 10080, tries outside 1-20, perRun outside 1-100, maxAgeDays outside 1-30", () => {
    for (const w of [0, 10081, 1.5]) {
      const s = clone(); s.rules.rate_limited.waitMinutes = w
      expect(parseAutoFulfilSettings(s).ok).toBe(false)
    }
    for (const t of [0, 21, 2.5]) {
      const s = clone(); s.rules.rate_limited.maxTries = t
      expect(parseAutoFulfilSettings(s).ok).toBe(false)
    }
    for (const p of [0, 101]) expect(parseAutoFulfilSettings({ ...D, perRun: p }).ok).toBe(false)
    for (const a of [0, 31]) expect(parseAutoFulfilSettings({ ...D, maxAgeDays: a }).ok).toBe(false)
    const edge = clone(); edge.rules.rate_limited.waitMinutes = 10080; edge.rules.rate_limited.maxTries = 20
    edge.perRun = 100; edge.maxAgeDays = 30; edge.minAgeMinutes = 120
    expect(parseAutoFulfilSettings(edge).ok).toBe(true)
  })

  it("rejects out-of-bounds numbers on a rule with retry false", () => {
    const s = clone(); s.rules.no_bundle.waitMinutes = 0
    expect(parseAutoFulfilSettings(s).ok).toBe(false)
  })

  it("rejects unknown networks, empty networks, a missing bucket, a non-boolean enabled", () => {
    expect(parseAutoFulfilSettings({ ...D, networks: ["MTN", "Glo"] }).ok).toBe(false)
    expect(parseAutoFulfilSettings({ ...D, networks: [] }).ok).toBe(false)
    const s = clone(); delete s.rules.wrong_number
    expect(parseAutoFulfilSettings(s).ok).toBe(false)
    expect(parseAutoFulfilSettings({ ...D, enabled: "true" }).ok).toBe(false)
    expect(parseAutoFulfilSettings(null).ok).toBe(false)
    expect(parseAutoFulfilSettings({ ...D, networks: AUTO_FULFIL_NETWORKS.slice(0, 2) }).ok).toBe(true)
  })

  it("loadAutoFulfilSettings: valid row is returned", async () => {
    const row = { ...clone(), enabled: true, perRun: 7 }
    const r = await loadAutoFulfilSettings(fakeDb({ data: { value: row }, error: null }))
    expect(r.valid).toBe(true)
    expect(r.settings.enabled).toBe(true)
    expect(r.settings.perRun).toBe(7)
  })
  it("loadAutoFulfilSettings: garbled row => enabled false, valid false", async () => {
    const r = await loadAutoFulfilSettings(fakeDb({ data: { value: { ...clone(), enabled: true, minAgeMinutes: 1 } }, error: null }))
    expect(r.valid).toBe(false)
    expect(r.settings.enabled).toBe(false)
  })
  it("loadAutoFulfilSettings: read error => enabled false, valid false", async () => {
    const r = await loadAutoFulfilSettings(fakeDb({ data: null, error: { message: "boom" } }))
    expect(r.valid).toBe(false)
    expect(r.settings.enabled).toBe(false)
  })
  it("loadAutoFulfilSettings: no row => defaults, valid true", async () => {
    const r = await loadAutoFulfilSettings(fakeDb({ data: null, error: null }))
    expect(r).toEqual({ settings: D, valid: true })
  })
})
