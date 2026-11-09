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

  it("DIRECT_ONLY_SURFACES is ussd + whatsapp", () => {
    expect([...DIRECT_ONLY_SURFACES]).toEqual(["ussd", "whatsapp"])
  })
})
