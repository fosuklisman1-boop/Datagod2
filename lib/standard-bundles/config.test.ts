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
