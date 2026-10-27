import { describe, it, expect } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  buildLiveFacts, FALLBACK_FACTS, formatCedis, networkOf, readSmsPricePerCredit, loadRawFacts,
  resolveLiveFacts, PartialFactsError, type RawFacts,
} from "./live-facts"
import { resolveBillsConfig } from "@/lib/bills/config"
import { PRODUCTS } from "./products"

function raw(over: Partial<RawFacts> = {}): RawFacts {
  return {
    packages: [],
    airtimeEnabled: { MTN: true, Telecel: true, AT: true },
    airtimeMin: 1,
    afaPrice: 50,
    bills: resolveBillsConfig({
      enabled: true,
      billers: {
        ecg: { enabled: true, min: 5, max: 1000 },
        ghana_water: { enabled: true, min: 5, max: 1000 },
        dstv: { enabled: true, min: 5, max: 1000 },
        gotv: { enabled: true, min: 5, max: 1000 },
        startimes: { enabled: true, min: 5, max: 1000 },
        telecel_broadband: { enabled: true, min: 5, max: 1000 },
      },
    }),
    results: [
      { board: "WASSCE", enabled: true, price: 20 },
      { board: "BECE", enabled: true, price: 15 },
      { board: "NOVDEC", enabled: true, price: 22 },
    ],
    smsPricePerCredit: 0.04,
    apiV2Enabled: true,
    ussd: { main: "*920#", shop: "*920*SHOPCODE#" },
    ...over,
  }
}

describe("networkOf", () => {
  it("maps every network string used for packages", () => {
    expect(networkOf("MTN")).toBe("MTN")
    expect(networkOf("mtn")).toBe("MTN")
    expect(networkOf("Telecel")).toBe("Telecel")
    expect(networkOf("AT-iShare")).toBe("AT")
    expect(networkOf("AT - BigTime")).toBe("AT")
    expect(networkOf("AT - ISHARE")).toBe("AT")
    expect(networkOf("AirtelTigo")).toBe("AT")
    expect(networkOf("iShare")).toBe("AT")
    expect(networkOf("Vodafone")).toBeNull()
    expect(networkOf("")).toBeNull()
  })
})

describe("buildLiveFacts — data", () => {
  it("takes the lowest available, positive price per network", () => {
    const f = buildLiveFacts(raw({
      packages: [
        { network: "MTN", price: 5, is_available: true },
        { network: "MTN", price: 3.5, is_available: true },
        { network: "MTN", price: 2, is_available: false },
      ],
    }))
    expect(f.products["mtn-data"]).toMatchObject({ available: true, fromPrice: 3.5 })
  })

  it("marks a network unavailable when all its packages are off", () => {
    const f = buildLiveFacts(raw({
      packages: [
        { network: "Telecel", price: 4, is_available: false },
        { network: "Telecel", price: 6, is_available: null },
      ],
    }))
    expect(f.products["telecel-data"].available).toBe(false)
    expect(f.products["telecel-data"].fromPrice).toBeNull()
  })

  it("ignores null, non-numeric and zero prices (no NaN, no 0)", () => {
    const f = buildLiveFacts(raw({
      packages: [
        { network: "AT-iShare", price: null, is_available: true },
        { network: "AT-iShare", price: "abc", is_available: true },
        { network: "AT - BigTime", price: 0, is_available: true },
        { network: "AT - BigTime", price: "4.20", is_available: true },
      ],
    }))
    expect(f.products["at-data"]).toMatchObject({ available: true, fromPrice: 4.2 })
  })

  it("only null/abc rows → unavailable", () => {
    const f = buildLiveFacts(raw({
      packages: [
        { network: "MTN", price: null, is_available: true },
        { network: "MTN", price: "abc", is_available: true },
      ],
    }))
    expect(f.products["mtn-data"].available).toBe(false)
    expect(f.products["mtn-data"].fromPrice).toBeNull()
  })
})

describe("buildLiveFacts — other products", () => {
  it("airtime lists enabled networks with the minimum amount", () => {
    const f = buildLiveFacts(raw({ airtimeEnabled: { MTN: true, Telecel: false, AT: true }, airtimeMin: 2 }))
    expect(f.products.airtime).toEqual({ available: true, fromPrice: 2, parts: ["MTN", "AT"] })
    const off = buildLiveFacts(raw({ airtimeEnabled: { MTN: false, Telecel: false, AT: false } }))
    expect(off.products.airtime.available).toBe(false)
  })

  it("afaPrice null → afa unavailable", () => {
    const f = buildLiveFacts(raw({ afaPrice: null }))
    expect(f.products["afa-registration"].available).toBe(false)
    expect(buildLiveFacts(raw({ afaPrice: 45 })).products["afa-registration"]).toMatchObject({ available: true, fromPrice: 45 })
  })

  it("bills disabled → hub and every biller unavailable", () => {
    const base = raw()
    const f = buildLiveFacts(raw({ bills: { ...base.bills!, enabled: false } }))
    for (const k of ["utility-bills", "ecg-prepaid", "ghana-water", "pay-dstv", "pay-gotv", "startimes", "telecel-broadband"] as const) {
      expect(f.products[k].available, k).toBe(false)
    }
    const none = buildLiveFacts(raw({ bills: null }))
    expect(none.products["utility-bills"].available).toBe(false)
  })

  it("bills on with only DSTV → only pay-dstv and the hub", () => {
    const f = buildLiveFacts(raw({ bills: resolveBillsConfig({ enabled: true, billers: { dstv: { enabled: true, min: 5, max: 100 } } }) }))
    expect(f.products["pay-dstv"].available).toBe(true)
    expect(f.products["ecg-prepaid"].available).toBe(false)
    expect(f.products["utility-bills"].available).toBe(true)
    expect(f.products["utility-bills"].parts).toEqual(["DSTV"])
    expect(f.products["utility-bills"].fromPrice).toBeNull()
    expect(f.products["pay-dstv"].fromPrice).toBeNull()
  })

  it("results: disabled board is excluded from parts and price", () => {
    const f = buildLiveFacts(raw({
      results: [
        { board: "WASSCE", enabled: true, price: 20 },
        { board: "BECE", enabled: false, price: 10 },
        { board: "NOVDEC", enabled: true, price: 18 },
      ],
    }))
    expect(f.products["results-checker"]).toEqual({ available: true, fromPrice: 18, parts: ["WASSCE", "NOVDEC"] })
    const off = buildLiveFacts(raw({ results: [{ board: "WASSCE", enabled: true, price: null }] }))
    expect(off.products["results-checker"].available).toBe(false)
  })

  it("bulk-sms always available with per-credit price", () => {
    expect(buildLiveFacts(raw({ smsPricePerCredit: 0.025 })).products["bulk-sms"]).toMatchObject({ available: true, fromPrice: 0.025 })
    expect(buildLiveFacts(raw({ smsPricePerCredit: null })).products["bulk-sms"]).toMatchObject({ available: true, fromPrice: null })
  })

  it("ussd.main null → ussd unavailable", () => {
    const f = buildLiveFacts(raw({ ussd: { main: null, shop: "*920*SHOPCODE#" } }))
    expect(f.products.ussd.available).toBe(false)
    expect(f.ussd).toEqual({ main: null, shop: "*920*SHOPCODE#" })
    expect(buildLiveFacts(raw()).products.ussd.available).toBe(true)
  })

  it("apiV2Enabled false → developers unavailable", () => {
    expect(buildLiveFacts(raw({ apiV2Enabled: false })).products.developers.available).toBe(false)
    expect(buildLiveFacts(raw()).products.developers.available).toBe(true)
  })

  it("join and whatsapp are always available", () => {
    const f = buildLiveFacts(raw({ apiV2Enabled: false, bills: null, afaPrice: null }))
    expect(f.products.join.available).toBe(true)
    expect(f.products.whatsapp.available).toBe(true)
  })

  it("returns facts for every registry key", () => {
    const f = buildLiveFacts(raw())
    for (const p of PRODUCTS) expect(f.products[p.key], p.key).toBeDefined()
  })
})

describe("FALLBACK_FACTS (every read failed)", () => {
  it("keeps data, join, whatsapp and bulk-sms on; switches everything else off; no prices", () => {
    const on = new Set(["mtn-data", "telecel-data", "at-data", "join", "whatsapp", "bulk-sms"])
    for (const p of PRODUCTS) {
      expect(FALLBACK_FACTS.products[p.key].available, p.key).toBe(on.has(p.key))
      expect(FALLBACK_FACTS.products[p.key].fromPrice, p.key).toBeNull()
    }
    expect(FALLBACK_FACTS.ussd).toEqual({ main: null, shop: null })
  })

  it("packages: null (read failed) → data pages on without prices", () => {
    const f = buildLiveFacts(raw({ packages: null }))
    for (const k of ["mtn-data", "telecel-data", "at-data"] as const) {
      expect(f.products[k], k).toMatchObject({ available: true, fromPrice: null })
    }
  })
})

// ── Fake Supabase client (repo pattern: minimal hand-rolled fake) ─────────
type Result = { data: unknown; error: unknown }
type Handler = (q: { table: string; eqs: Array<[string, unknown]>; select: string }) => Result

function fakeDb(handlers: Record<string, Handler>) {
  const calls: Array<{ table: string; eqs: Array<[string, unknown]>; select: string }> = []
  const client = {
    from(table: string) {
      const q = { table, eqs: [] as Array<[string, unknown]>, select: "" }
      calls.push(q)
      const run = (): Promise<Result> => {
        const h = handlers[table]
        return Promise.resolve(h ? h(q) : { data: null, error: { message: `no handler for ${table}` } })
      }
      const builder: any = {
        select(cols: string) { q.select = cols; return builder },
        eq(col: string, v: unknown) { q.eqs.push([col, v]); return builder },
        in() { return builder },
        limit() { return builder },
        maybeSingle: run,
        single: run,
        then(res: (r: Result) => unknown, rej?: (e: unknown) => unknown) { return run().then(res, rej) },
      }
      return builder
    },
  }
  return { db: client as unknown as SupabaseClient, calls }
}

const keyOf = (q: { eqs: Array<[string, unknown]> }) => q.eqs.find(([c]) => c === "key")?.[1]

function healthyHandlers(): Record<string, Handler> {
  return {
    packages: () => ({ data: [{ network: "MTN", price: 4, is_available: true }], error: null }),
    afa_registration_prices: () => ({ data: { price: "45.00" }, error: null }),
    admin_settings: (q) => {
      const k = String(keyOf(q))
      if (k === "utility_bills_config") return { data: { value: { enabled: true, billers: { dstv: { enabled: true, min: 5, max: 100 } } } }, error: null }
      if (k.startsWith("results_checker_enabled_")) return { data: { value: { enabled: true } }, error: null }
      if (k.startsWith("results_checker_price_")) return { data: { value: { price: "20" } }, error: null }
      return { data: null, error: null }
    },
    tenant_global_settings: () => ({ data: { value: { amount: 0.035 } }, error: null }),
    api_v2_config: () => ({ data: { enabled: true }, error: null }),
    app_settings: () => ({ data: { value: { main: "*920#", shop: null } }, error: null }),
  }
}

const deps = {
  isAirtimeEnabled: async (n: string) => n !== "Telecel",
  getAirtimeLimits: async () => ({ min: 2, max: 500 }),
}

describe("readSmsPricePerCredit", () => {
  it("reads .amount from tenant_global_settings", async () => {
    const { db, calls } = fakeDb({ tenant_global_settings: () => ({ data: { value: { amount: 0.025 } }, error: null }) })
    expect(await readSmsPricePerCredit(db)).toBe(0.025)
    expect(calls[0].table).toBe("tenant_global_settings")
    expect(keyOf(calls[0])).toBe("sms_price_per_credit")
  })
  it("returns null (not a default) when the row is missing or invalid", async () => {
    expect(await readSmsPricePerCredit(fakeDb({ tenant_global_settings: () => ({ data: null, error: null }) }).db)).toBeNull()
    expect(await readSmsPricePerCredit(fakeDb({ tenant_global_settings: () => ({ data: { value: { amount: 0 } }, error: null }) }).db)).toBeNull()
    expect(await readSmsPricePerCredit(fakeDb({ tenant_global_settings: () => ({ data: { value: { amount: "x" } }, error: null }) }).db)).toBeNull()
  })
  it("throws on a read error", async () => {
    await expect(readSmsPricePerCredit(fakeDb({ tenant_global_settings: () => ({ data: null, error: { message: "boom" } }) }).db)).rejects.toThrow()
  })
})

describe("loadRawFacts", () => {
  it("reads every source and reports no failures when healthy", async () => {
    const { db, calls } = fakeDb(healthyHandlers())
    const { raw: r, failed } = await loadRawFacts(db, deps)
    expect(failed).toEqual([])
    const f = buildLiveFacts(r)
    expect(f.products["mtn-data"]).toMatchObject({ available: true, fromPrice: 4 })
    expect(f.products["afa-registration"]).toMatchObject({ available: true, fromPrice: 45 })
    expect(f.products.airtime).toEqual({ available: true, fromPrice: 2, parts: ["MTN", "AT"] })
    expect(f.products["pay-dstv"].available).toBe(true)
    expect(f.products["results-checker"]).toMatchObject({ available: true, fromPrice: 20 })
    expect(f.products["bulk-sms"].fromPrice).toBe(0.035)
    expect(f.products.developers.available).toBe(true)
    expect(f.products.ussd.available).toBe(true)
    // packages filtered by is_available in SQL
    const pkg = calls.find((c) => c.table === "packages")!
    expect(pkg.eqs).toContainEqual(["is_available", true])
    expect(pkg.select).toBe("network, price, is_available")
  })

  it("fails each switchable source closed, independently", async () => {
    const err = () => ({ data: null, error: { message: "boom" } })
    const h = healthyHandlers()
    const { db } = fakeDb({
      ...h,
      afa_registration_prices: err,
      api_v2_config: err,
      app_settings: err,
      admin_settings: (q) => (String(keyOf(q)) === "utility_bills_config" || String(keyOf(q)).startsWith("results_") ? err() : h.admin_settings(q)),
    })
    const { raw: r, failed } = await loadRawFacts(db, deps)
    expect(failed.sort()).toEqual(["afa", "api-v2", "bills", "results", "ussd"])
    const f = buildLiveFacts(r)
    expect(f.products["afa-registration"].available).toBe(false)
    expect(f.products.developers.available).toBe(false)
    expect(f.products.ussd.available).toBe(false)
    expect(f.ussd).toEqual({ main: null, shop: null })
    expect(f.products["utility-bills"].available).toBe(false)
    expect(f.products["pay-dstv"].available).toBe(false)
    expect(f.products["results-checker"].available).toBe(false)
    // untouched sources still live
    expect(f.products["mtn-data"]).toMatchObject({ available: true, fromPrice: 4 })
    expect(f.products.airtime.available).toBe(true)
  })

  it("packages / sms / airtime failures: data on without prices, bulk-sms on without price, airtime off", async () => {
    const err = () => ({ data: null, error: { message: "boom" } })
    const { db } = fakeDb({ ...healthyHandlers(), packages: err, tenant_global_settings: err })
    const { raw: r, failed } = await loadRawFacts(db, {
      isAirtimeEnabled: async () => { throw new Error("down") },
      getAirtimeLimits: async () => ({ min: 1, max: 500 }),
    })
    expect(failed.sort()).toEqual(["airtime", "packages", "sms"])
    const f = buildLiveFacts(r)
    for (const k of ["mtn-data", "telecel-data", "at-data"] as const) expect(f.products[k]).toMatchObject({ available: true, fromPrice: null })
    expect(f.products["bulk-sms"]).toMatchObject({ available: true, fromPrice: null })
    expect(f.products.airtime.available).toBe(false)
  })
})

describe("resolveLiveFacts", () => {
  it("passes a complete result through", async () => {
    const full = buildLiveFacts(raw())
    expect(await resolveLiveFacts(async () => full)).toBe(full)
  })
  it("builds facts from the partial raw carried by PartialFactsError", async () => {
    const partial = raw({ apiV2Enabled: false })
    const f = await resolveLiveFacts(async () => { throw new PartialFactsError(partial, ["api-v2"]) })
    expect(f.products.developers.available).toBe(false)
    expect(f.products["mtn-data"]).toBeDefined()
  })
  it("returns FALLBACK_FACTS on any other error", async () => {
    expect(await resolveLiveFacts(async () => { throw new Error("cache down") })).toBe(FALLBACK_FACTS)
  })
})

describe("formatCedis", () => {
  it("formats amounts >= 1 with 2 decimals", () => {
    expect(formatCedis(3.5)).toBe("GH₵3.50")
    expect(formatCedis(12)).toBe("GH₵12.00")
  })
  it("keeps up to 3 decimals below 1, trimming but keeping at least 2", () => {
    expect(formatCedis(0.025)).toBe("GH₵0.025")
    expect(formatCedis(0.5)).toBe("GH₵0.50")
    expect(formatCedis(0.04)).toBe("GH₵0.04")
  })
  it("returns an empty string for non-finite or non-positive input", () => {
    expect(formatCedis(0)).toBe("")
    expect(formatCedis(-2)).toBe("")
    expect(formatCedis(NaN)).toBe("")
    expect(formatCedis(Infinity)).toBe("")
  })
})
