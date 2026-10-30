import { describe, it, expect, beforeEach, vi } from "vitest"
import { getCatalog, __resetCatalogCache, CATALOG_CACHE_TTL_MS, type CatalogDeps } from "./catalog"
import { verifyBundleToken } from "./token"
import type { BundlesConfig } from "./config"

const T0 = 1_800_000_000_000
const cfg = (over: Partial<BundlesConfig["networks"]["MTN"]> = {}, enabled = true): BundlesConfig => ({
  enabled,
  networks: {
    MTN: { enabled: true, hiddenCategories: [], referenceNumber: "233240000000", ...over },
    TELECEL: { enabled: false, hiddenCategories: [], referenceNumber: "233200000000" },
    AT: { enabled: true, hiddenCategories: [], referenceNumber: "233260000000" },
  },
  special: { enabled: false, multiples: [3, 5, 8, 10, 15], unitAmount: 3 },
})

const ITEMS = [
  { Value: "x_Video_1", Display: "Video 1", Amount: 3 },
  { Value: "x_Data_1", Display: "Data 1", Amount: 5 },
  { Value: "weird", Display: "Weird", Amount: 2 },
  { Value: "x_Data_2", Display: "Data 2", Amount: 9 },
] as any

function deps(over: Partial<CatalogDeps> = {}): CatalogDeps & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => ({ ok: true as const, data: ITEMS }))
  return {
    getBundlesConfig: async () => cfg(),
    getHubtelConfig: async () => ({ enabled: true, paused: false, services: { data_mtn: true, data_at: true } }),
    query,
    secret: "s",
    now: () => T0,
    ...over,
  } as any
}

beforeEach(() => __resetCatalogCache())

describe("getCatalog", () => {
  it("groups in order, Other last, signs tokens, queries reference number", async () => {
    const d = deps()
    const r = await getCatalog(d, "MTN")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.categories.map(c => c.name)).toEqual(["Data", "Video", "Other"])
    expect(r.categories[0].bundles.map(b => b.amount)).toEqual([5, 9])
    const b = r.categories[0].bundles[0]
    expect(verifyBundleToken(b.token, "s", T0)).toMatchObject({ network: "MTN", value: "x_Data_1", amount: 5, category: "Data" })
    expect(d.query).toHaveBeenCalledWith("data_mtn", "233240000000")
  })

  it("caches within TTL, refetches after, and re-signs issuedAt", async () => {
    let t = T0
    const d = deps({ now: () => t })
    const a = await getCatalog(d, "MTN")
    t = T0 + 60_000
    const b = await getCatalog(d, "MTN")
    expect(d.query).toHaveBeenCalledTimes(1)
    expect(a.ok && b.ok && a.categories[0].bundles[0].token !== b.categories[0].bundles[0].token).toBe(true)
    t = T0 + CATALOG_CACHE_TTL_MS
    await getCatalog(d, "MTN")
    expect(d.query).toHaveBeenCalledTimes(2)
  })

  it("applies hidden categories after the cache", async () => {
    let hidden: string[] = []
    const d = deps({ getBundlesConfig: async () => cfg({ hiddenCategories: hidden }) })
    await getCatalog(d, "MTN")
    hidden = ["Video", "Other"]
    const r = await getCatalog(d, "MTN")
    expect(d.query).toHaveBeenCalledTimes(1)
    expect(r.ok && r.categories.map(c => c.name)).toEqual(["Data"])
  })

  it("403 when master or network disabled", async () => {
    expect(await getCatalog(deps({ getBundlesConfig: async () => cfg({}, false) }), "MTN"))
      .toEqual({ ok: false, status: 403, error: "Standard Bundles are not available" })
    expect(await getCatalog(deps(), "TELECEL"))
      .toEqual({ ok: false, status: 403, error: "Standard Bundles are not available" })
  })

  it("503 when Hubtel or the service is disabled, or config throws", async () => {
    const msg = { ok: false, status: 503, error: "Bundles unavailable right now" }
    expect(await getCatalog(deps({ getHubtelConfig: async () => ({ enabled: false, paused: false, services: { data_mtn: true } }) }), "MTN")).toEqual(msg)
    expect(await getCatalog(deps({ getHubtelConfig: async () => ({ enabled: true, paused: false, services: {} }) }), "MTN")).toEqual(msg)
    expect(await getCatalog(deps({ getBundlesConfig: async () => { throw new Error("db") } }), "MTN")).toEqual(msg)
    expect(await getCatalog(deps({ getHubtelConfig: async () => { throw new Error("db") } }), "MTN")).toEqual(msg)
  })

  it("allows browsing while Hubtel is paused", async () => {
    const d = deps({ getHubtelConfig: async () => ({ enabled: true, paused: true, services: { data_mtn: true } }) })
    expect((await getCatalog(d, "MTN")).ok).toBe(true)
  })

  it("503 without leaking detail on Hubtel error or throw, and does not cache failures", async () => {
    const d = deps()
    d.query.mockResolvedValueOnce({ ok: false, error: "secret detail" })
    expect(await getCatalog(d, "MTN")).toEqual({ ok: false, status: 503, error: "Bundles unavailable right now" })
    d.query.mockRejectedValueOnce(new Error("boom"))
    expect(await getCatalog(d, "MTN")).toEqual({ ok: false, status: 503, error: "Bundles unavailable right now" })
    expect((await getCatalog(d, "MTN")).ok).toBe(true)
  })

  it("503 when secret is empty", async () => {
    expect((await getCatalog(deps({ secret: "" }), "MTN")).ok).toBe(false)
  })
})
