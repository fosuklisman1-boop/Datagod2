import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// The catalog route prices with the same gateway rule as initialize. The real storefrontCatalog runs over a fake
// bundles engine; only the gateway config, readiness and the engine's network calls are fakes.

const h = vi.hoisted(() => ({ config: null as any, ready: true }))

vi.mock("@/lib/payment-gateway/read-config", () => ({
  getGatewayConfig: async () => h.config,
  getSurfaceConfig: async (s: string) => h.config.surfaces[s],
}))
vi.mock("@/lib/payment-gateway/hubtel-readiness", () => ({ isHubtelCollectionReady: () => h.ready }))
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: async () => ({ allowed: true }) }))
vi.mock("@/lib/storefront-commission/shop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storefront-commission/shop")>()),
  resolveShop: async () => ({ id: "shop-A" }),
}))
vi.mock("@/lib/standard-bundles/runtime", async () => {
  const { resolveCashbackConfig } = await import("@/lib/cashback/config")
  const { resolveBundlesConfig } = await import("@/lib/standard-bundles/config")
  const deps = {
    getCashbackConfig: async () => resolveCashbackConfig({
      enabled: true, surfaces: { storefront: true }, rates: { "data_mtn:hubtel": 3.96 },
      shares: { bundles: { customer: 0, dealer: 0, storefrontCustomer: 20, storefrontShop: 40 } },
      paymentFee: { bundles: 1.95 }, storefrontGroups: { bundles: true },
    }),
    getBuyerTier: async () => "customer",
    getBundlesConfig: async () => resolveBundlesConfig({ enabled: true, networks: { MTN: { enabled: true, hiddenCategories: [] } } }),
    getHubtelConfig: async () => ({ enabled: true, paused: false, services: { data_mtn: true } }),
    query: async () => ({ ok: true, data: [{ Display: "1GB", Value: "x_Data_1", Amount: 10 }] }),
    secret: "s3cret",
    now: () => 1_700_000_000_000,
  }
  return { getBundlesRuntime: () => ({ db: {}, deps }) }
})

import { GET } from "./route"

function config(storefront?: Record<string, string>) {
  const surfaces: Record<string, any> = {}
  for (const s of ["wallet_topup", "storefront", "dashboard_direct", "sms", "ussd", "whatsapp"]) {
    surfaces[s] = { gateway: "paystack", mode: "checkout", feeBearer: "customer" }
  }
  if (storefront) surfaces.storefront = { gateway: "hubtel", mode: "checkout", feeBearer: "customer", ...storefront }
  return { version: 1, surfaces, hubtelFeePercent: 2 }
}

const firstBundle = async () => {
  const res = await GET(new NextRequest("http://x/api/shop/bundles/catalog?shop=myshop&network=MTN"))
  expect(res.status).toBe(200)
  const json = await res.json()
  return json.categories.flatMap((c: any) => c.bundles)[0]
}

beforeEach(() => {
  h.config = config()
  h.ready = true
})

describe("the storefront bundle catalog follows the gateway", () => {
  it("Paystack: today's price, with the payment fee", async () => {
    const b = await firstBundle()
    expect(b.paymentFee).toBeGreaterThan(0)
  })

  it("Hubtel: the same bundle with no payment fee in its price", async () => {
    const paystack = await firstBundle()
    h.config = config({})
    const hubtel = await firstBundle()
    expect(hubtel.paymentFee).toBe(0)
    expect(hubtel.payAmount).toBeCloseTo(paystack.payAmount - paystack.paymentFee, 2)
  })

  it("Hubtel set but not ready: today's price", async () => {
    h.config = config({})
    h.ready = false
    expect((await firstBundle()).paymentFee).toBeGreaterThan(0)
  })
})
