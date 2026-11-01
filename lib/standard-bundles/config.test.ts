import { describe, expect, it } from "vitest"
import {
  BUNDLES_CONFIG_KEY, getBundlesConfig, isValidReferenceNumber, resolveBundlesConfig, setBundlesConfig, validateBundlesPatch,
} from "./config"

const ns = (o: Partial<{ enabled: any; hiddenCategories: any; referenceNumber: any }> = {}) =>
  ({ enabled: true, hiddenCategories: [], referenceNumber: "233246912184", ...o })

describe("bundles config", () => {
  it("key", () => expect(BUNDLES_CONFIG_KEY).toBe("standard_bundles_config"))
  it("ships dark with Hubtel sample reference numbers", () => {
    const c = resolveBundlesConfig(null)
    expect(c.enabled).toBe(false)
    expect(c.networks.MTN).toEqual({ enabled: false, hiddenCategories: [], referenceNumber: "233246912184" })
    expect(c.networks.TELECEL.referenceNumber).toBe("233206439599")
    expect(c.networks.AT.referenceNumber).toBe("233273833933")
    expect(c.networks.AT.enabled).toBe(false)
  })
  it("only literal true enables; bad values fall back", () => {
    const c = resolveBundlesConfig({
      enabled: "true",
      networks: {
        MTN: { enabled: true, hiddenCategories: ["Night"], referenceNumber: "0246912184" },
        TELECEL: { enabled: 1, hiddenCategories: [1], referenceNumber: "233000000000" },
        AT: { enabled: true, hiddenCategories: Array(21).fill("x"), referenceNumber: "233273833933" },
      },
    })
    expect(c.enabled).toBe(false)
    expect(c.networks.MTN).toEqual({ enabled: true, hiddenCategories: ["Night"], referenceNumber: "233246912184" })
    expect(c.networks.TELECEL).toEqual({ enabled: false, hiddenCategories: [], referenceNumber: "233206439599" })
    expect(c.networks.AT.hiddenCategories).toEqual([])
    expect(resolveBundlesConfig(["x"]).enabled).toBe(false)
  })
  it("reference number must be a 233 Ghana mobile", () => {
    expect(isValidReferenceNumber("233246912184")).toBe(true)
    expect(isValidReferenceNumber("0246912184")).toBe(false)
    expect(isValidReferenceNumber("+233246912184")).toBe(false)
    expect(isValidReferenceNumber("2332469121845")).toBe(false)
    expect(isValidReferenceNumber(233246912184)).toBe(false)
  })
  it("validates patches strictly", () => {
    expect(validateBundlesPatch({ enabled: true })).toEqual({ ok: true, patch: { enabled: true } })
    expect(validateBundlesPatch({ networks: { MTN: ns({ hiddenCategories: ["Night"] }) } }).ok).toBe(true)
    expect(validateBundlesPatch({ nope: 1 }).ok).toBe(false)
    expect(validateBundlesPatch({ enabled: "yes" }).ok).toBe(false)
    expect(validateBundlesPatch({ networks: { GLO: ns() } }).ok).toBe(false)
    expect(validateBundlesPatch({ networks: { MTN: { enabled: true } } }).ok).toBe(false)
    expect(validateBundlesPatch({ networks: { MTN: ns({ referenceNumber: "0246912184" }) } }).ok).toBe(false)
    expect(validateBundlesPatch({ networks: { MTN: ns({ hiddenCategories: [5] }) } }).ok).toBe(false)
    expect(validateBundlesPatch({ networks: { MTN: ns({ hiddenCategories: Array(21).fill("x") }) } }).ok).toBe(false)
    expect(validateBundlesPatch({ networks: { MTN: ns({ hiddenCategories: ["x".repeat(41)] }) } }).ok).toBe(false)
    expect(validateBundlesPatch({ networks: { MTN: ns({ enabled: "true" }) } }).ok).toBe(false)
    expect(validateBundlesPatch([]).ok).toBe(false)
  })
  describe("special bundles", () => {
    const UV = "RACT_Data_GHC_3_Others"
    const DEF = { enabled: false, multiples: [3, 5, 8, 10, 15], unitAmount: 3, unitValue: UV }
    it("defaults to dark with the default multiples and unit value", () => {
      expect(resolveBundlesConfig(null).special).toEqual(DEF)
      expect(resolveBundlesConfig({ enabled: true }).special).toEqual(DEF)
    })
    it("resolves a valid special, sorted and deduped", () => {
      const c = resolveBundlesConfig({ special: { enabled: true, multiples: [10, 3, 3, 5], unitAmount: 2.5, unitValue: "db-Data_x9" } })
      expect(c.special).toEqual({ enabled: true, multiples: [3, 5, 10], unitAmount: 2.5, unitValue: "db-Data_x9" })
    })
    it("a stored special without unitValue gets the default unit value", () => {
      const c = resolveBundlesConfig({ special: { enabled: true, multiples: [10, 3, 3, 5], unitAmount: 2.5 } })
      expect(c.special).toEqual({ enabled: true, multiples: [3, 5, 10], unitAmount: 2.5, unitValue: UV })
    })
    it("an invalid unitValue resolves to disabled defaults", () => {
      for (const unitValue of ["", " ", "a b", "x".repeat(81), "RACT.Data", "ü", 3, null]) {
        expect(resolveBundlesConfig({ special: { enabled: true, multiples: [3], unitAmount: 3, unitValue } }).special).toEqual(DEF)
      }
      expect(resolveBundlesConfig({ special: { enabled: true, multiples: [3], unitAmount: 3, unitValue: "x".repeat(80) } }).special.enabled).toBe(true)
    })
    it("invalid special resolves to disabled defaults", () => {
      const bad: any[] = [
        "x", [], { enabled: true },
        { enabled: true, multiples: [], unitAmount: 3 },
        { enabled: true, multiples: [0], unitAmount: 3 },
        { enabled: true, multiples: [21], unitAmount: 3 },
        { enabled: true, multiples: [3, 50], unitAmount: 3 },
        { enabled: true, multiples: [1.5], unitAmount: 3 },
        { enabled: true, multiples: ["3"], unitAmount: 3 },
        { enabled: true, multiples: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], unitAmount: 3 },
        { enabled: true, multiples: [3], unitAmount: 0 },
        { enabled: true, multiples: [3], unitAmount: -1 },
        { enabled: true, multiples: [3], unitAmount: 1.234 },
        { enabled: true, multiples: [3], unitAmount: "3" },
        { enabled: true, multiples: [3], unitAmount: NaN },
        { enabled: "true", multiples: [3], unitAmount: 3 },
      ]
      for (const special of bad) expect(resolveBundlesConfig({ special }).special).toEqual(DEF)
    })
    it("does not change the existing fields", () => {
      const c = resolveBundlesConfig({ enabled: true, special: { enabled: true, multiples: [3], unitAmount: 3 } })
      expect(c.enabled).toBe(true)
      expect(c.networks.MTN.referenceNumber).toBe("233246912184")
    })
    it("validates special patches", () => {
      const ok = validateBundlesPatch({ special: { enabled: true, multiples: [15, 3, 5, 3], unitAmount: 3, unitValue: UV } })
      expect(ok).toEqual({ ok: true, patch: { special: { enabled: true, multiples: [3, 5, 15], unitAmount: 3, unitValue: UV } } })
      expect(validateBundlesPatch({ enabled: true, special: { enabled: false, multiples: [3], unitAmount: 3.5, unitValue: UV } }).ok).toBe(true)
      expect(validateBundlesPatch({ special: { enabled: true, multiples: Array.from({ length: 10 }, (_, i) => i + 1), unitAmount: 3, unitValue: UV } }).ok).toBe(true)
      // Cap is 20 (dispatch time budget ruling); the 0141 RPC keeps 1..50 as the outer bound.
      expect(validateBundlesPatch({ special: { enabled: true, multiples: [20], unitAmount: 0.01, unitValue: "x".repeat(80) } }).ok).toBe(true)
      expect(validateBundlesPatch({ special: { enabled: true, multiples: [21], unitAmount: 3, unitValue: UV } }).ok).toBe(false)
      expect(validateBundlesPatch({ special: { enabled: true, multiples: [50], unitAmount: 3, unitValue: UV } }).ok).toBe(false)
      expect(resolveBundlesConfig({ special: { enabled: true, multiples: [20], unitAmount: 3, unitValue: UV } }).special.multiples).toEqual([20])
      // unitValue is required in a patch (the RPC replaces `special` whole) and must be [A-Za-z0-9_-]{1,80}.
      for (const unitValue of [undefined, "", " ", "a b", "x".repeat(81), "RACT.Data", "ü", 3, null]) {
        const r = validateBundlesPatch({ special: { enabled: true, multiples: [3], unitAmount: 3, ...(unitValue === undefined ? {} : { unitValue }) } })
        expect(r.ok).toBe(false)
      }
      const bad: any[] = [
        null, [], { enabled: true, multiples: [3] }, { multiples: [3], unitAmount: 3 }, { enabled: 1, multiples: [3], unitAmount: 3 },
        { enabled: true, multiples: [], unitAmount: 3 }, { enabled: true, multiples: "3,5", unitAmount: 3 },
        { enabled: true, multiples: [0], unitAmount: 3 }, { enabled: true, multiples: [51], unitAmount: 3 },
        { enabled: true, multiples: [2.5], unitAmount: 3 },
        { enabled: true, multiples: Array.from({ length: 11 }, (_, i) => i + 1), unitAmount: 3 },
        { enabled: true, multiples: [3], unitAmount: 0 }, { enabled: true, multiples: [3], unitAmount: 1.001 },
        { enabled: true, multiples: [3], unitAmount: "3" }, { enabled: true, multiples: [3], unitAmount: Infinity },
        { enabled: true, multiples: [3], unitAmount: 3, extra: 1 },
      ]
      for (const special of bad) expect(validateBundlesPatch({ special }).ok).toBe(false)
      // Same cases with a valid unitValue: still refused for their original reason.
      for (const special of bad) {
        const withUv = special && typeof special === "object" && !Array.isArray(special) ? { ...special, unitValue: UV } : special
        expect(validateBundlesPatch({ special: withUv }).ok).toBe(false)
      }
    })
    it("existing patch shapes still validate unchanged", () => {
      expect(validateBundlesPatch({ enabled: true })).toEqual({ ok: true, patch: { enabled: true } })
      expect(validateBundlesPatch({ nope: 1 }).ok).toBe(false)
    })
  })
  it("setBundlesConfig calls the RPC with the validated patch", async () => {
    const calls: any[] = []
    const db = { rpc: async (fn: string, args: any) => { calls.push({ fn, args }); return { data: { enabled: true }, error: null } } } as any
    const c = await setBundlesConfig(db, { enabled: true })
    expect(calls).toEqual([{ fn: "standard_bundles_config_patch", args: { p_patch: { enabled: true } } }])
    expect(c.enabled).toBe(true)
  })
  it("getBundlesConfig reads admin_settings and throws on error", async () => {
    const mk = (res: any) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => res }) }) }) }) as any
    expect((await getBundlesConfig(mk({ data: { value: { enabled: true } }, error: null }))).enabled).toBe(true)
    expect((await getBundlesConfig(mk({ data: null, error: null }))).enabled).toBe(false)
    await expect(getBundlesConfig(mk({ data: null, error: new Error("boom") }))).rejects.toThrow("boom")
  })
})
