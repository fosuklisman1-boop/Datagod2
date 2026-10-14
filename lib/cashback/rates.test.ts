import { describe, it, expect } from "vitest"
import { buildCashbackRates } from "./rates"
import { resolveCashbackConfig } from "./config"
import type { AirtimeProvider } from "../airtime-provider"

const cfg = (over: Record<string, unknown> = {}) => resolveCashbackConfig({
  enabled: true,
  surfaces: { dashboard: true },
  rates: { "airtime_mtn:digiwapy": 3.96, "airtime_mtn:hubtel": 3.96, "airtime_at:hubtel": 4 },
  shares: { airtime: { customer: 25, dealer: 50, storefrontCustomer: 0, storefrontShop: 0 } },
  ...over,
})

const providers = (map: Record<string, AirtimeProvider>) => async (network: string) => map[network] ?? "manual"

describe("buildCashbackRates", () => {
  it("digiwapy provider with Digiwapy configured is published", async () => {
    const r = await buildCashbackRates(cfg(), "customer", providers({ MTN: "digiwapy" }), true)
    expect(r.services.airtime_mtn).toEqual({ provider: "digiwapy", rate: 3.96, share: 25 })
    expect(r.applied).toBe(true)
  })

  it("digiwapy provider without its env is NOT published (it would fall to manual)", async () => {
    const r = await buildCashbackRates(cfg(), "customer", providers({ MTN: "digiwapy" }), false)
    expect(r.services.airtime_mtn).toBeUndefined()
  })

  it("hubtel is unaffected by the Digiwapy env and carries maxFace", async () => {
    const r = await buildCashbackRates(cfg(), "dealer", providers({ MTN: "hubtel", AT: "hubtel" }), false)
    expect(r.services.airtime_mtn).toMatchObject({ provider: "hubtel", share: 50 })
    expect(r.services.airtime_mtn.maxFace).toBeGreaterThan(0)
    expect(r.services.airtime_at).toMatchObject({ provider: "hubtel", rate: 4 })
  })

  it("manual provider and switched-off config publish nothing", async () => {
    expect((await buildCashbackRates(cfg(), "customer", providers({}), true)).applied).toBe(false)
    expect((await buildCashbackRates(cfg({ enabled: false }), "customer", providers({ MTN: "hubtel" }), true)).applied).toBe(false)
  })
})
