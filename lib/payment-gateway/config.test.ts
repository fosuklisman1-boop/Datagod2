import { describe, it, expect } from "vitest"
import {
  SURFACE_KEYS,
  DIRECT_ONLY_SURFACES,
  deriveFromLegacy,
  sanitizeGatewayConfig,
  validateGatewayConfigUpdate,
  type GatewayConfig,
} from "@/lib/payment-gateway/config"

const fb = deriveFromLegacy({ storefrontDirect: true, walletDirect: false })

function validFull(): GatewayConfig {
  return JSON.parse(JSON.stringify(fb))
}

describe("deriveFromLegacy", () => {
  it("maps legacy flags to per-surface modes", () => {
    const c = deriveFromLegacy({ storefrontDirect: true, walletDirect: false })
    expect(c.version).toBe(1)
    expect(c.surfaces.storefront.mode).toBe("direct")
    for (const k of ["wallet_topup", "dashboard_direct", "sms"] as const) {
      expect(c.surfaces[k].mode).toBe("checkout")
    }
    expect(c.surfaces.ussd.mode).toBe("direct")
    expect(c.surfaces.whatsapp.mode).toBe("direct")
    for (const k of SURFACE_KEYS) {
      expect(c.surfaces[k].gateway).toBe("paystack")
      expect(c.surfaces[k].feeBearer).toBe("customer")
    }
    expect(c.hubtelFeePercent).toBe(0)
  })

  it("walletDirect drives wallet_topup, dashboard_direct, sms", () => {
    const c = deriveFromLegacy({ storefrontDirect: false, walletDirect: true })
    expect(c.surfaces.storefront.mode).toBe("checkout")
    for (const k of ["wallet_topup", "dashboard_direct", "sms"] as const) {
      expect(c.surfaces[k].mode).toBe("direct")
    }
  })
})

describe("sanitizeGatewayConfig", () => {
  it("falls back field-by-field, forces direct-only, clamps fee", () => {
    const c = sanitizeGatewayConfig(
      {
        surfaces: {
          ussd: { gateway: "paystack", mode: "checkout", feeBearer: "customer" },
          storefront: { gateway: "stripe" },
        },
        hubtelFeePercent: 250,
      },
      fb,
    )
    expect(c.surfaces.ussd.mode).toBe("direct")
    expect(c.surfaces.storefront.gateway).toBe(fb.surfaces.storefront.gateway)
    expect(c.surfaces.storefront).toEqual(fb.surfaces.storefront)
    expect(c.surfaces.sms).toEqual(fb.surfaces.sms)
    expect(c.hubtelFeePercent).toBe(100)
  })

  it("returns fallback for null / garbage", () => {
    expect(sanitizeGatewayConfig(null, fb)).toEqual(fb)
    expect(sanitizeGatewayConfig("garbage", fb)).toEqual(fb)
  })

  it("forces direct-only surfaces even if fallback says checkout", () => {
    const bad = validFull()
    bad.surfaces.whatsapp.mode = "checkout"
    expect(sanitizeGatewayConfig(null, bad).surfaces.whatsapp.mode).toBe("direct")
  })

  it("non-finite fee uses fallback; negative clamps to 0", () => {
    expect(sanitizeGatewayConfig({ hubtelFeePercent: NaN }, fb).hubtelFeePercent).toBe(0)
    expect(sanitizeGatewayConfig({ hubtelFeePercent: "x" }, fb).hubtelFeePercent).toBe(0)
    expect(sanitizeGatewayConfig({ hubtelFeePercent: -5 }, fb).hubtelFeePercent).toBe(0)
  })
})

describe("validateGatewayConfigUpdate", () => {
  it("accepts a valid full config", () => {
    const r = validateGatewayConfigUpdate(validFull(), { hubtelReady: false })
    expect(r.ok).toBe(true)
  })

  it("rejects hubtel when not ready", () => {
    const c = validFull()
    c.surfaces.storefront.gateway = "hubtel"
    expect(validateGatewayConfigUpdate(c, { hubtelReady: false })).toEqual({
      ok: false,
      error: "Hubtel is not configured",
    })
    expect(validateGatewayConfigUpdate(c, { hubtelReady: true }).ok).toBe(true)
  })

  it("rejects checkout on direct-only surfaces", () => {
    const c = validFull()
    c.surfaces.whatsapp.mode = "checkout"
    expect(validateGatewayConfigUpdate(c, { hubtelReady: true })).toEqual({
      ok: false,
      error: "whatsapp must use direct mode",
    })
  })

  it("rejects missing surface and non-objects", () => {
    const c = validFull() as unknown as { surfaces: Record<string, unknown> }
    delete c.surfaces.sms
    expect(validateGatewayConfigUpdate(c, { hubtelReady: true }).ok).toBe(false)
    expect(validateGatewayConfigUpdate(null, { hubtelReady: true }).ok).toBe(false)
  })

  it("rejects bad enum values and fee out of range", () => {
    const c = validFull()
    ;(c.surfaces.sms as unknown as { feeBearer: string }).feeBearer = "nobody"
    expect(validateGatewayConfigUpdate(c, { hubtelReady: true }).ok).toBe(false)
    const d = validFull()
    d.hubtelFeePercent = 101
    expect(validateGatewayConfigUpdate(d, { hubtelReady: true }).ok).toBe(false)
  })

  it("DIRECT_ONLY_SURFACES is ussd + whatsapp + sms_order", () => {
    expect([...DIRECT_ONLY_SURFACES]).toEqual(["ussd", "whatsapp", "sms_order"])
  })
})

describe("sms_order surface", () => {
  const SIX = ["wallet_topup", "storefront", "dashboard_direct", "sms", "ussd", "whatsapp"] as const
  const DEFAULT = { gateway: "paystack", mode: "direct", feeBearer: "customer" }

  // A config exactly as the code before sms_order saved it: six surfaces, non-default values.
  const storedBeforeSmsOrder = {
    version: 1,
    surfaces: {
      wallet_topup: { gateway: "hubtel", mode: "direct", feeBearer: "merchant" },
      storefront: { gateway: "paystack", mode: "checkout", feeBearer: "merchant" },
      dashboard_direct: { gateway: "hubtel", mode: "checkout", feeBearer: "customer" },
      sms: { gateway: "paystack", mode: "direct", feeBearer: "merchant" },
      ussd: { gateway: "hubtel", mode: "direct", feeBearer: "merchant" },
      whatsapp: { gateway: "hubtel", mode: "direct", feeBearer: "customer" },
    },
    hubtelFeePercent: 1.5,
  }

  it("is a listed surface and derives to paystack/direct/customer", () => {
    expect(SURFACE_KEYS).toContain("sms_order")
    for (const legacy of [
      { storefrontDirect: true, walletDirect: true },
      { storefrontDirect: false, walletDirect: false },
    ]) {
      expect(deriveFromLegacy(legacy).surfaces.sms_order).toEqual(DEFAULT)
    }
  })

  it("a config saved before sms_order loads: sms_order defaults, the other six are unchanged byte for byte", () => {
    const stored = JSON.parse(JSON.stringify(storedBeforeSmsOrder))
    const c = sanitizeGatewayConfig(stored, fb)
    expect(c.surfaces.sms_order).toEqual(DEFAULT)
    for (const k of SIX) {
      expect(JSON.stringify(c.surfaces[k])).toBe(JSON.stringify(storedBeforeSmsOrder.surfaces[k]))
    }
    expect(c.hubtelFeePercent).toBe(1.5)
    // Reading never mutates the stored value.
    expect(stored).toEqual(storedBeforeSmsOrder)
  })

  it("keeps a stored sms_order gateway/fee but coerces checkout to direct", () => {
    const c = sanitizeGatewayConfig(
      { surfaces: { sms_order: { gateway: "hubtel", mode: "checkout", feeBearer: "merchant" } } },
      fb,
    )
    expect(c.surfaces.sms_order).toEqual({ gateway: "hubtel", mode: "direct", feeBearer: "merchant" })
  })

  it("an admin update rejects checkout for sms_order and accepts hubtel/direct", () => {
    const bad = validFull()
    ;(bad.surfaces.sms_order as unknown as { mode: string }).mode = "checkout"
    const r = validateGatewayConfigUpdate(bad, { hubtelReady: true })
    expect(r).toEqual({ ok: false, error: "sms_order must use direct mode" })

    const good = validFull()
    good.surfaces.sms_order.gateway = "hubtel"
    const ok = validateGatewayConfigUpdate(good, { hubtelReady: true })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.config.surfaces.sms_order).toEqual({ gateway: "hubtel", mode: "direct", feeBearer: "customer" })
  })
})
