import { describe, it, expect, beforeEach, vi } from "vitest"
import fixture from "@/lib/hubtel-cs/testing/fixtures/live-bundle-query-2026-10-13.json"
import type { HubtelQueryItem } from "@/lib/hubtel-cs/types"
import {
  parseBundleMb, findSpecialUnit, buildSpecialEntries, formatSpecialGb, getDashboardCatalog, SPECIAL_CATEGORY,
} from "./special"
import { getCatalog, __resetCatalogCache, type CatalogDeps } from "./catalog"
import { parseCatalog, type CatalogBundle } from "./categories"
import { verifySpecialToken, verifyBundleToken } from "./token"
import type { BundlesConfig } from "./config"

const T0 = 1_800_000_000_000
const S = "s"

const b = (over: Partial<CatalogBundle>): CatalogBundle => ({ value: "v", display: "", amount: 3, category: "Data", ...over })

describe("parseBundleMb", () => {
  it("parses MB, GB and decimals (1GB = 1000MB, house convention)", () => {
    expect(parseBundleMb("406.89MB", "")).toBe(406.89)
    expect(parseBundleMb("406.80MB", "")).toBe(406.8)
    expect(parseBundleMb("500 MB", "")).toBe(500)
    expect(parseBundleMb("1.39GB", "")).toBe(1390)
    expect(parseBundleMb("2 gb", "")).toBe(2000)
    expect(parseBundleMb("Non Expiry 406.89MB", "")).toBe(406.89)
  })
  it("falls back to the value when the display has no size", () => {
    expect(parseBundleMb("Non Expiry", "db_Data_1GB")).toBe(1000)
    expect(parseBundleMb("", "flexi_250MB_x")).toBe(250)
  })
  it("prefers the display over the value", () => {
    expect(parseBundleMb("300MB", "db_Data_1GB")).toBe(300)
  })
  it("returns null for junk", () => {
    expect(parseBundleMb("", "")).toBeNull()
    expect(parseBundleMb("Non Expiry", "RACT_Data_GHC_3_Others")).toBeNull()
    expect(parseBundleMb("MB", "GB")).toBeNull()
    expect(parseBundleMb("0MB", "")).toBeNull()
    expect(parseBundleMb("12MBps", "")).toBeNull()
    expect(parseBundleMb("1.2.3GB", "")).toBeNull()
    expect(parseBundleMb(undefined as any, null as any)).toBeNull()
  })
})

describe("findSpecialUnit", () => {
  it("null when nothing matches amount, rule and size", () => {
    expect(findSpecialUnit([], 3)).toBeNull()
    expect(findSpecialUnit([b({ display: "406MB Non Expiry", amount: 5 })], 3)).toBeNull() // wrong amount
    expect(findSpecialUnit([b({ display: "406MB" })], 3)).toBeNull() // no non-expiry/flexi marker
    expect(findSpecialUnit([b({ display: "Non Expiry" })], 3)).toBeNull() // no parseable size
  })
  it("matches on category or display (non-expiry / non expiry / nonexpiry / flexi)", () => {
    expect(findSpecialUnit([b({ display: "406.89MB", category: "No Expiry" })], 3)).toBeNull()
    expect(findSpecialUnit([b({ display: "406.89MB", category: "Non-Expiry" })], 3)?.mb).toBe(406.89)
    expect(findSpecialUnit([b({ display: "Non Expiry 406.89MB" })], 3)?.mb).toBe(406.89)
    expect(findSpecialUnit([b({ display: "NonExpiry 406.89MB" })], 3)?.mb).toBe(406.89)
    expect(findSpecialUnit([b({ display: "Flexi 406.89MB" })], 3)?.mb).toBe(406.89)
  })
  it("does not match on the value alone (rule is category or display)", () => {
    expect(findSpecialUnit([b({ display: "406.89MB", value: "RACT_Data_Flexi_Bundle" })], 3)).toBeNull()
  })
  it("several matching: largest size wins, then smallest value string", () => {
    const pick = findSpecialUnit([
      b({ value: "c", display: "Flexi 300MB" }),
      b({ value: "b", display: "Flexi 406.89MB" }),
      b({ value: "a", display: "Flexi 406.89MB" }),
      b({ value: "z", display: "Flexi 1GB", amount: 3.01 }),
    ], 3)
    expect(pick?.bundle.value).toBe("a")
    expect(pick?.mb).toBe(406.89)
  })
  it("is order-independent", () => {
    const items = [b({ value: "b", display: "Flexi 400MB" }), b({ value: "a", display: "Flexi 400MB" })]
    expect(findSpecialUnit(items, 3)?.bundle.value).toBe("a")
    expect(findSpecialUnit([...items].reverse(), 3)?.bundle.value).toBe("a")
  })
  it("compares amounts to the cent", () => {
    expect(findSpecialUnit([b({ display: "Flexi 400MB", amount: 1.5 })], 1.5)?.mb).toBe(400)
    expect(findSpecialUnit([b({ display: "Flexi 400MB", amount: 1.51 })], 1.5)).toBeNull()
  })
  it("live 2026-10-13 fixture: the GHS 3 MTN item does NOT satisfy the rule (see task-2 report concern)", () => {
    const mtn = parseCatalog("MTN", (fixture as any).MTN.Data as HubtelQueryItem[])
    const ghs3 = mtn.find((x) => x.amount === 3)
    expect(ghs3).toEqual({ value: "RACT_Data_GHC_3_Others", display: "406.89MB", amount: 3, category: "Data" })
    expect(findSpecialUnit(mtn, 3)).toBeNull()
  })
})

describe("formatSpecialGb", () => {
  it("reproduces the screenshot for 3/5/8/10/15 × 406.89MB", () => {
    expect([3, 5, 8, 10, 15].map((n) => formatSpecialGb(n * 406.89))).toEqual(["1.22GB", "2.03GB", "3.26GB", "4.07GB", "6.10GB"])
  })
  it("406.80MB (as written in the brief) gives 3.25 for 8×, not the screenshot's 3.26", () => {
    expect([3, 5, 8, 10, 15].map((n) => formatSpecialGb(n * 406.8))).toEqual(["1.22GB", "2.03GB", "3.25GB", "4.07GB", "6.10GB"])
  })
})

describe("buildSpecialEntries", () => {
  const unit = { bundle: b({ value: "RACT_Data_Flexi_3", display: "Non Expiry 406.89MB", amount: 3, category: "Data" }), mb: 406.89 }

  it("one entry per multiple, Special category, N × amount, GB display, special metadata", () => {
    const es = buildSpecialEntries(unit, [3, 5, 8, 10, 15], S, T0)
    expect(es.map((e) => [e.display, e.amount, e.category])).toEqual([
      ["1.22GB", 9, SPECIAL_CATEGORY],
      ["2.03GB", 15, SPECIAL_CATEGORY],
      ["3.26GB", 24, SPECIAL_CATEGORY],
      ["4.07GB", 30, SPECIAL_CATEGORY],
      ["6.10GB", 45, SPECIAL_CATEGORY],
    ])
    expect(es[0].special).toEqual({ n: 3, unitAmount: 3, unitDisplay: "Non Expiry 406.89MB" })
    expect(new Set(es.map((e) => e.value)).size).toBe(5)
  })
  it("amount is rounded to the cent", () => {
    const es = buildSpecialEntries({ bundle: b({ display: "Flexi 400MB", amount: 1.1 }), mb: 400 }, [3], S, T0)
    expect(es[0].amount).toBe(3.3)
  })
  it("token verifies as special carrying the unit and n, and never as a normal token", () => {
    const [e] = buildSpecialEntries(unit, [5], S, T0)
    expect(verifySpecialToken(e.token, S, T0)).toEqual({
      n: 5,
      issuedAt: T0,
      unit: { network: "MTN", value: "RACT_Data_Flexi_3", amount: 3, display: "Non Expiry 406.89MB", category: "Data", issuedAt: T0 },
    })
    expect(verifyBundleToken(e.token, S, T0)).toBeNull()
  })
})

// ---- dashboard catalog composition ----

const cfg = (special: Partial<BundlesConfig["special"]> = {}): BundlesConfig => ({
  enabled: true,
  networks: {
    MTN: { enabled: true, hiddenCategories: [], referenceNumber: "233240000000" },
    TELECEL: { enabled: true, hiddenCategories: [], referenceNumber: "233200000000" },
    AT: { enabled: true, hiddenCategories: [], referenceNumber: "233260000000" },
  },
  special: { enabled: false, multiples: [3, 5], unitAmount: 3, ...special },
})

const ITEMS = [
  { Value: "x_Data_1", Display: "1GB", Amount: 5 },
  { Value: "x_Data_NE", Display: "Non Expiry 406.89MB", Amount: 3 },
  { Value: "x_Video_1", Display: "Video 1", Amount: 3 },
] as any

function deps(c: BundlesConfig): CatalogDeps {
  return {
    getBundlesConfig: async () => c,
    getHubtelConfig: async () => ({ enabled: true, paused: false, services: { data_mtn: true, data_telecel: true, data_at: true } }),
    query: vi.fn(async () => ({ ok: true as const, data: ITEMS })),
    secret: S,
    now: () => T0,
  }
}

beforeEach(() => __resetCatalogCache())

describe("getDashboardCatalog", () => {
  it("switch off: identical to getCatalog", async () => {
    const d = deps(cfg())
    const plain = await getCatalog(d, "MTN")
    __resetCatalogCache()
    expect(await getDashboardCatalog(d, "MTN")).toEqual(plain)
  })
  it("switch on: Special Bundles listed first for MTN, rest unchanged", async () => {
    const d = deps(cfg({ enabled: true }))
    const plain = await getCatalog(d, "MTN")
    const r = await getDashboardCatalog(d, "MTN")
    expect(r.ok).toBe(true)
    if (!r.ok || !plain.ok) return
    expect(r.categories[0].name).toBe(SPECIAL_CATEGORY)
    expect(r.categories[0].bundles.map((e) => [e.display, e.amount])).toEqual([["1.22GB", 9], ["2.03GB", 15]])
    expect(r.categories.slice(1)).toEqual(plain.categories)
  })
  it("switch on but getCatalog itself never contains Special (storefront/API/bot stay byte-identical)", async () => {
    const r = await getCatalog(deps(cfg({ enabled: true })), "MTN")
    expect(r.ok && r.categories.map((c) => c.name)).toEqual(["Data", "Video"])
  })
  it("switch on: non-MTN networks unchanged", async () => {
    for (const n of ["TELECEL", "AT"] as const) {
      const d = deps(cfg({ enabled: true }))
      const plain = await getCatalog(d, n)
      expect(await getDashboardCatalog(d, n)).toEqual(plain)
    }
  })
  it("switch on but no unit found: unchanged", async () => {
    const d = deps(cfg({ enabled: true, unitAmount: 4 }))
    const plain = await getCatalog(d, "MTN")
    expect(await getDashboardCatalog(d, "MTN")).toEqual(plain)
  })
  it("unit is found even when its category is hidden from the normal list", async () => {
    const c = cfg({ enabled: true })
    c.networks.MTN.hiddenCategories = ["Data"]
    const r = await getDashboardCatalog(deps(c), "MTN")
    expect(r.ok && r.categories.map((x) => x.name)).toEqual([SPECIAL_CATEGORY, "Video"])
  })
  it("errors pass through untouched", async () => {
    const c = cfg({ enabled: true }); c.enabled = false
    expect(await getDashboardCatalog(deps(c), "MTN")).toEqual({ ok: false, status: 403, error: "Standard Bundles are not available" })
  })
  it("reads the config once and uses the same snapshot for the catalog and Special", async () => {
    let calls = 0
    const d = deps(cfg())
    d.getBundlesConfig = async () => (++calls === 1 ? cfg({ enabled: true }) : cfg())
    const r = await getDashboardCatalog(d, "MTN")
    expect(calls).toBe(1)
    expect(r.ok && r.categories[0].name).toBe(SPECIAL_CATEGORY)
  })
  it("config read failing: same error as getCatalog", async () => {
    const d = deps(cfg({ enabled: true }))
    d.getBundlesConfig = async () => { throw new Error("db") }
    expect(await getDashboardCatalog(d, "MTN")).toEqual({ ok: false, status: 503, error: "Bundles unavailable right now" })
  })
})
