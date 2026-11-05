import { beforeEach, describe, expect, it, vi } from "vitest"
import type { NextRequest } from "next/server"

// The storefront runtimes hand the services a paymentFeeWaived that reads the real gateway resolution (config and
// readiness are the only fakes), so a Hubtel storefront prices orders, availability terms and the catalog fee-free.

const h = vi.hoisted(() => ({
  config: null as any,
  ready: true,
  configError: false,
}))

vi.mock("@/lib/payment-gateway/read-config", () => ({
  getGatewayConfig: async () => {
    if (h.configError) throw new Error("db down")
    return h.config
  },
  getSurfaceConfig: async (s: string) => h.config.surfaces[s],
}))
vi.mock("@/lib/payment-gateway/hubtel-readiness", () => ({ isHubtelCollectionReady: () => h.ready }))
vi.mock("@/lib/bills/runtime", () => ({
  getBillsRuntime: () => ({ db: {}, deps: { alert: async () => {} } }),
  getBillsAvailability: async () => ({ enabled: false, billers: [] }),
}))
vi.mock("@/lib/standard-bundles/runtime", () => ({
  getBundlesRuntime: () => ({ db: {}, deps: { getCashbackConfig: async () => ({}), getHubtelConfig: async () => ({}) } }),
  getBundlesAvailability: async () => ({ enabled: false, networks: [] }),
}))
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: vi.fn() }))
vi.mock("@/lib/turnstile", () => ({ verifyTurnstileToken: vi.fn(), getRequestIp: vi.fn(), isTurnstileEnabled: vi.fn() }))
vi.mock("@/lib/storefront-otp", () => ({ isStorefrontOtpRequired: vi.fn(), isPhoneOtpVerified: vi.fn() }))
vi.mock("@/lib/shop-token", () => ({ verifyShopSession: vi.fn() }))

import { getAvailabilityRuntime, getStorefrontBillsRuntime, getStorefrontBundlesRuntime } from "./runtime"

function config(storefront?: { feeBearer?: string; gateway?: string }) {
  const surfaces: Record<string, any> = {}
  for (const s of ["wallet_topup", "storefront", "dashboard_direct", "sms", "ussd", "whatsapp"]) {
    surfaces[s] = { gateway: "paystack", mode: "checkout", feeBearer: "customer" }
  }
  if (storefront) surfaces.storefront = { gateway: storefront.gateway ?? "hubtel", mode: "checkout", feeBearer: storefront.feeBearer ?? "customer" }
  return { version: 1, surfaces, hubtelFeePercent: 2 }
}

const req = {} as NextRequest
const waived = () => Promise.all([
  getStorefrontBillsRuntime(req).deps.paymentFeeWaived!(),
  getStorefrontBundlesRuntime(req).deps.paymentFeeWaived!(),
  getAvailabilityRuntime().deps.paymentFeeWaived!(),
])

beforeEach(() => {
  h.config = config()
  h.ready = true
  h.configError = false
})

describe("the storefront runtimes' paymentFeeWaived", () => {
  it("storefront on Hubtel and ready: waived in all three", async () => {
    h.config = config({})
    expect(await waived()).toEqual([true, true, true])
  })

  it("Paystack with the merchant bearing the fee: waived", async () => {
    h.config = config({ gateway: "paystack", feeBearer: "merchant" })
    expect(await waived()).toEqual([true, true, true])
  })

  it.each<[string, () => void]>([
    ["every surface on Paystack", () => {}],
    ["Hubtel set but not ready", () => { h.config = config({}); h.ready = false }],
    ["the config can't be read", () => { h.configError = true }],
    ["another surface on Hubtel", () => { h.config = config(); h.config.surfaces.wallet_topup.gateway = "hubtel" }],
  ])("%s: not waived, today's prices", async (_n, arrange) => {
    arrange()
    expect(await waived()).toEqual([false, false, false])
  })
})
