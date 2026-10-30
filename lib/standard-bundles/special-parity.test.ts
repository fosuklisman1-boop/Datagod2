import { describe, expect, it } from "vitest"
import { resolveCashbackConfig, effectiveShares, type CashbackConfig } from "@/lib/cashback/config"
import { buildCashbackRates } from "@/lib/cashback/rates"
import { quoteCashback } from "@/lib/cashback/quote"
import { quoteBundle, type BundlesDeps } from "./service"
import { bundleCardPrice } from "./special-ui"

/**
 * "Price shown = price charged" for Special Bundles, end to end on ONE shared cashback config:
 * - client: /api/cashback/rates entry (buildCashbackRates) -> bundleCardPrice (card, sheet and expectedPay);
 * - server: buySpecial's per-unit quote, quoteBundle(d, userId, "data_mtn", unitAmount, "dashboard"), total = cents(unit pay) x n.
 */
const cents = (n: number) => Math.round(n * 100)
const noAirtime = async () => "manual" as const

const sharedCfg = (rate: number): CashbackConfig => resolveCashbackConfig({
  enabled: true,
  surfaces: { dashboard: true },
  rates: { "data_mtn:hubtel": rate, "data_telecel:hubtel": 2 },
  shares: {
    bundles: { customer: 33.33, dealer: 47.5, storefrontCustomer: 10, storefrontShop: 5 },
    // The override must win on both sides (rates route and server quote).
    overrides: { data_mtn: { dealer: 61.27 } },
  },
})

/** Only the two deps quoteBundle reads; everything else is unused on this path. */
const deps = (cfg: CashbackConfig, buyer: "customer" | "dealer") =>
  ({ getCashbackConfig: async () => cfg, getBuyerTier: async () => buyer }) as unknown as BundlesDeps

async function serverTotal(cfg: CashbackConfig, buyer: "customer" | "dealer", unitAmount: number, n: number): Promise<number> {
  const q = await quoteBundle(deps(cfg, buyer), "u1", "data_mtn", unitAmount, "dashboard")
  // Same identity buySpecial checks: unit pay = face - floored cashback.
  const direct = quoteCashback({ serviceKey: "data_mtn", provider: "hubtel", faceAmount: unitAmount, buyer, channel: "dashboard" }, cfg)
  expect(q).toEqual(direct)
  return (cents(q.payAmount) * n) / 100
}

describe("Special Bundles price parity (display vs server) on one shared config", () => {
  it("the override is live: dealer and customer get different shares on data_mtn", () => {
    const cfg = sharedCfg(4.137)
    expect(effectiveShares(cfg, "data_mtn")).toMatchObject({ customer: 33.33, dealer: 61.27 })
  })

  for (const rate of [4.137, 3.96, 7.5, 1.234]) {
    for (const buyer of ["customer", "dealer"] as const) {
      for (const unitAmount of [3, 2.37, 4.99]) {
        it(`rate ${rate}, ${buyer}, unit GHS ${unitAmount}: card pay == server total for n = 3/5/8/10/15`, async () => {
          const cfg = sharedCfg(rate)
          const rates = await buildCashbackRates(cfg, buyer, noAirtime, false)
          const entry = rates.services["data_mtn"]
          expect(entry).toBeDefined()
          expect(entry.share).toBe(effectiveShares(cfg, "data_mtn")[buyer])
          for (const n of [3, 5, 8, 10, 15]) {
            const shown = bundleCardPrice({ amount: unitAmount * n, special: { n, unitAmount, unitDisplay: "406.89MB" } }, entry)
            const charged = await serverTotal(cfg, buyer, unitAmount, n)
            expect(shown.pay).toBe(charged)
            expect(shown.face).toBe((cents(unitAmount) * n) / 100)
          }
        })
      }
    }
  }

  it("cashback off (no data_mtn entry): shown = charged = n x face", async () => {
    const cfg = resolveCashbackConfig({ enabled: true, surfaces: { dashboard: true }, rates: {}, shares: {} })
    const rates = await buildCashbackRates(cfg, "customer", noAirtime, false)
    for (const n of [3, 5, 8, 10, 15]) {
      const shown = bundleCardPrice({ amount: 3 * n, special: { n, unitAmount: 3, unitDisplay: "406.89MB" } }, rates.services["data_mtn"])
      expect(shown.pay).toBe(await serverTotal(cfg, "customer", 3, n))
      expect(shown.pay).toBe(3 * n)
    }
  })
})
