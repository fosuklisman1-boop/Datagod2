/**
 * Live product facts for the public SEO surfaces: which products are on right
 * now and their lowest "from" price. buildLiveFacts() is pure; getLiveFacts()
 * reads the DB (service role) and is cached for an hour under the
 * "seo-live-facts" tag. Each source is read independently and fails closed
 * (see FAILED_RAW): switches go off, prices go null, the data catalog stays
 * on. A result with any failed source is never cached, so a DB blip neither
 * 500s a page nor advertises a dark product for an hour.
 *
 * The result also lists which sources failed (failedSources), so a product
 * page can tell "the admin switched this off" (render it, 200) apart from
 * "we could not read whether it is on" (answer 5xx so crawlers retry); see
 * productFactsLoaded().
 */
import { cache } from "react"
import { unstable_cache } from "next/cache"
import type { SupabaseClient } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase"
import { isAirtimeEnabled, getAirtimeLimits } from "@/lib/airtime-pricing"
import { getBillsConfig, type BillsConfig } from "@/lib/bills/config"
import { BILLERS, type BillerKey } from "@/lib/bills/billers"
import { readPublicUssdCodes, type PublicUssdCodes } from "./ussd-codes"
import type { ProductKey } from "./products"
import { buildPriceGroups, isNoExpiry, networkOf, type PriceGroups } from "./data-prices"
import { buildComparison } from "./compare"
import type { PriceAdjustments } from "@/lib/price-adjustment-service"

export interface ProductFacts {
  available: boolean
  fromPrice: number | null
  /** live networks / billers / exam boards */
  parts: string[]
}

/** One independently-read source of live facts (see loadRawFacts). */
export type FactSource = "packages" | "price-adjust" | "afa" | "airtime" | "bills" | "results" | "sms" | "api-v2" | "ussd"

export const FACT_SOURCES: readonly FactSource[] = ["packages", "price-adjust", "afa", "airtime", "bills", "results", "sms", "api-v2", "ussd"]

export type LiveFacts = {
  products: Record<ProductKey, ProductFacts>
  ussd: PublicUssdCodes
  /** adjusted customer price lists per network (empty when prices are unavailable) */
  prices: PriceGroups
  /**
   * The same adjusted price lists, restricted to packages whose description
   * says they do not expire (isNoExpiry). For /non-expiry-data-bundles.
   */
  nonExpiryPrices: PriceGroups
  /** ISO timestamp of when these facts were built */
  loadedAt: string
  /**
   * Sources whose read failed for this result. Their products carry fail-closed
   * values, so `available: false` there means "unknown", not "switched off".
   */
  failedSources: FactSource[]
}

/** The adjusted data prices need both the catalogue and the adjustment percentages. */
export const PRICE_SOURCES: readonly FactSource[] = ["packages", "price-adjust"]

/**
 * The sources each product's own facts (availability, from-price) come from;
 * empty for products that are always on and have no price.
 */
export const PRODUCT_SOURCES: Record<ProductKey, readonly FactSource[]> = {
  "mtn-data": PRICE_SOURCES,
  "telecel-data": PRICE_SOURCES,
  "at-data": PRICE_SOURCES,
  "cheapest-data": PRICE_SOURCES,
  airtime: ["airtime"],
  "afa-registration": ["afa"],
  "utility-bills": ["bills"],
  "ecg-prepaid": ["bills"],
  "ghana-water": ["bills"],
  "pay-dstv": ["bills"],
  "pay-gotv": ["bills"],
  startimes: ["bills"],
  "telecel-broadband": ["bills"],
  "results-checker": ["results"],
  "bulk-sms": ["sms"],
  developers: ["api-v2"],
  ussd: ["ussd"],
  join: [],
  whatsapp: [],
}

/** True when none of `sources` failed for this result. */
export function sourcesLoaded(sources: readonly FactSource[], facts: LiveFacts): boolean {
  const failed = facts.failedSources ?? []
  return !sources.some((s) => failed.includes(s))
}

/** False when a source behind this product's facts failed to load (its facts are fail-closed guesses). */
export function productFactsLoaded(key: ProductKey, facts: LiveFacts): boolean {
  return sourcesLoaded(PRODUCT_SOURCES[key] ?? [], facts)
}

/**
 * Thrown by a product (or landing) page whose facts could not be read. Not
 * caught by the page, so Next answers 500 and nothing is cached; see
 * components/seo/product-page.tsx and components/seo/landing-page.tsx.
 * `key` is a ProductKey or a LandingKey (lib/seo/landing-pages.ts).
 */
export class LiveFactsUnavailableError extends Error {
  constructor(readonly key: string, readonly failedSources: readonly FactSource[]) {
    super(`seo live facts unavailable for ${key} (failed: ${failedSources.join(", ") || "unknown"})`)
    this.name = "LiveFactsUnavailableError"
  }
}

type Net = "MTN" | "Telecel" | "AT"
type Board = "WASSCE" | "BECE" | "NOVDEC"

export interface RawFacts {
  /** null = the packages read failed (data pages stay on, no prices) */
  packages: Array<{
    network: string
    size?: string | null
    price: number | string | null
    is_available: boolean | null
    /** admin-written; only read for the no-expiry list (isNoExpiry) */
    description?: string | null
  }> | null
  /** null = the singleton app_settings adjustments read failed (no prices) */
  priceAdjustments: PriceAdjustments | null
  airtimeEnabled: Record<Net, boolean>
  airtimeMin: number
  afaPrice: number | null
  bills: BillsConfig | null
  results: Array<{ board: Board; enabled: boolean; price: number | null }>
  smsPricePerCredit: number | null
  apiV2Enabled: boolean
  ussd: PublicUssdCodes
}

const NETS: readonly Net[] = ["MTN", "Telecel", "AT"]
const BOARDS: readonly Board[] = ["WASSCE", "BECE", "NOVDEC"]

const DATA_KEY: Record<Net, ProductKey> = { MTN: "mtn-data", Telecel: "telecel-data", AT: "at-data" }

const BILLER_PAGE: Record<BillerKey, ProductKey> = {
  ecg: "ecg-prepaid",
  ghana_water: "ghana-water",
  dstv: "pay-dstv",
  gotv: "pay-gotv",
  startimes: "startimes",
  telecel_broadband: "telecel-broadband",
}

/** Short public names for the bills hub `parts`. */
const BILLER_SHORT: Record<BillerKey, string> = {
  ecg: "ECG",
  ghana_water: "Ghana Water",
  dstv: "DSTV",
  gotv: "GOtv",
  startimes: "StarTimes",
  telecel_broadband: "Telecel Broadband",
}

export { networkOf }

/** Finite, strictly positive number or null. Accepts numeric strings. */
function positive(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === "string" && v.trim() === "") return null
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

const minOf = (xs: number[]): number | null => (xs.length ? Math.min(...xs) : null)
const fact = (available: boolean, fromPrice: number | null = null, parts: string[] = []): ProductFacts => ({ available, fromPrice, parts })

/** `failed`: names of sources whose read failed (unknown names are ignored). */
export function buildLiveFacts(
  raw: RawFacts,
  failed: readonly string[] = [],
  loadedAt: string = new Date().toISOString(),
): LiveFacts {
  const products = {} as Record<ProductKey, ProductFacts>

  // Data — per network, lowest available positive ADJUSTED price (the price shown on the customer dashboard).
  // packages or priceAdjustments === null means a read failed: keep data pages on,
  // without prices and with empty price groups.
  const priced = raw.packages !== null && raw.priceAdjustments !== null
  const groups: PriceGroups = priced
    ? buildPriceGroups(raw.packages!, raw.priceAdjustments!)
    : { MTN: [], Telecel: [], AT: [] }
  const nonExpiryPrices: PriceGroups = priced
    ? buildPriceGroups(raw.packages!.filter((r) => isNoExpiry(r.description)), raw.priceAdjustments!)
    : { MTN: [], Telecel: [], AT: [] }
  for (const net of NETS) {
    if (raw.packages === null || raw.priceAdjustments === null) {
      products[DATA_KEY[net]] = fact(true, null, [net])
      continue
    }
    const from = minOf(groups[net].flatMap((g) => g.rows.map((r) => r.price)))
    products[DATA_KEY[net]] = fact(from !== null, from, from !== null ? [net] : [])
  }

  // Cheapest-data comparison: live only when the comparison has something to show
  // (a best per-GB figure or an exact-size row), so the page can never go live empty.
  const allPrices = NETS.flatMap((n) => groups[n].flatMap((g) => g.rows.map((r) => r.price)))
  const cheapestFrom = minOf(allPrices)
  const cmp = buildComparison(groups)
  products["cheapest-data"] = fact(
    cmp.best.length > 0 || cmp.sizes.length > 0,
    cheapestFrom,
    NETS.filter((n) => groups[n].some((g) => g.rows.length > 0)),
  )

  // Airtime
  const airtimeNets = NETS.filter((n) => raw.airtimeEnabled?.[n] === true)
  products.airtime = fact(airtimeNets.length > 0, positive(raw.airtimeMin), airtimeNets)

  // AFA
  const afa = positive(raw.afaPrice)
  products["afa-registration"] = fact(afa !== null, afa)

  // Bills — the customer chooses the amount, so never a "from" price.
  const billsOn = raw.bills?.enabled === true
  const liveBillers: BillerKey[] = []
  for (const key of Object.keys(BILLER_PAGE) as BillerKey[]) {
    const on = billsOn && raw.bills?.billers?.[key]?.enabled === true
    if (on) liveBillers.push(key)
    products[BILLER_PAGE[key]] = fact(on, null, on ? [BILLERS[key].label] : [])
  }
  products["utility-bills"] = fact(liveBillers.length > 0, null, liveBillers.map((k) => BILLER_SHORT[k]))

  // Results checker
  const liveBoards = (raw.results ?? []).filter((r) => r.enabled && positive(r.price) !== null)
  const boardParts = BOARDS.filter((b) => liveBoards.some((r) => r.board === b))
  products["results-checker"] = fact(
    liveBoards.length > 0,
    minOf(liveBoards.map((r) => positive(r.price) as number)),
    boardParts,
  )

  // Always-on products
  products["bulk-sms"] = fact(true, positive(raw.smsPricePerCredit))
  products.join = fact(true)
  products.whatsapp = fact(true)

  // Switchable
  products.developers = fact(raw.apiV2Enabled === true)
  products.ussd = fact(raw.ussd?.main != null)

  return {
    products,
    ussd: { main: raw.ussd?.main ?? null, shop: raw.ussd?.shop ?? null },
    prices: groups,
    nonExpiryPrices,
    loadedAt,
    failedSources: FACT_SOURCES.filter((src) => failed.includes(src)),
  }
}

/**
 * The fail-closed value of every source, used when that source's read fails.
 * Switches go OFF (never advertise something that might be dark); the data
 * catalog stays on without prices; prices are null.
 */
export const FAILED_RAW: RawFacts = {
  packages: null,
  priceAdjustments: null,
  airtimeEnabled: { MTN: false, Telecel: false, AT: false },
  airtimeMin: 0,
  afaPrice: null,
  bills: null,
  results: [],
  smsPricePerCredit: null,
  apiV2Enabled: false,
  ussd: { main: null, shop: null },
}

/**
 * "Every read failed": data pages on (no prices); bills, results, AFA,
 * airtime, developers and USSD off; join, whatsapp and bulk-sms on.
 */
export const FALLBACK_FACTS: LiveFacts = buildLiveFacts(FAILED_RAW, FACT_SOURCES)

/**
 * "GH₵3.50" for amounts >= 1; below 1 keep up to 3 decimals, trimming
 * trailing zeros but never below 2 ("GH₵0.025", "GH₵0.50"). "" for
 * non-finite or non-positive input.
 */
export function formatCedis(n: number): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return ""
  if (n >= 1) return `GH₵${n.toFixed(2)}`
  let s = n.toFixed(3)
  if (s.endsWith("0")) s = s.slice(0, -1)
  return `GH₵${s}`
}

// ── Loader ───────────────────────────────────────────────────────────

type Db = SupabaseClient

async function readSetting(db: Db, key: string): Promise<any> {
  const { data, error } = await db.from("admin_settings").select("value").eq("key", key).maybeSingle()
  if (error) throw new Error(`admin_settings read failed (${key})`)
  return data?.value ?? null
}

function settingNumber(value: any, field: string): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === "number" || typeof value === "string") return positive(value)
  return positive(value?.[field])
}

/**
 * Bulk SMS selling price per credit, from tenant_global_settings (the table
 * lib/sms/admin-settings.ts writes and lib/sms/bundle-service.ts charges from).
 * null when the row is absent or invalid; deliberately NOT getPricePerCredit's
 * 0.04 default, so we never quote a price the admin didn't set. Throws on a
 * read error.
 */
export async function readSmsPricePerCredit(db: Db): Promise<number | null> {
  const { data, error } = await db
    .from("tenant_global_settings")
    .select("value")
    .eq("key", "sms_price_per_credit")
    .maybeSingle()
  if (error) throw new Error("tenant_global_settings read failed (sms_price_per_credit)")
  return settingNumber((data as { value?: unknown } | null)?.value ?? null, "amount")
}

export interface LoaderDeps {
  isAirtimeEnabled: (network: string) => Promise<boolean>
  getAirtimeLimits: () => Promise<{ min: number; max: number }>
}

const DEFAULT_DEPS: LoaderDeps = { isAirtimeEnabled, getAirtimeLimits }

/**
 * Reads every source independently. A failed source takes its fail-closed
 * value from FAILED_RAW and its name is added to `failed`.
 */
export async function loadRawFacts(
  db: Db,
  deps: LoaderDeps = DEFAULT_DEPS,
): Promise<{ raw: RawFacts; failed: FactSource[] }> {
  const failed: FactSource[] = []
  async function source<T>(name: FactSource, fallback: T, read: () => Promise<T>): Promise<T> {
    try {
      return await read()
    } catch {
      failed.push(name)
      return fallback
    }
  }

  const [packages, priceAdjustments, afaPrice, airtime, bills, results, smsPricePerCredit, apiV2Enabled, ussd] = await Promise.all([
    source("packages", FAILED_RAW.packages, async () => {
      const { data, error } = await db
        .from("packages")
        .select("network, size, price, is_available, description")
        .eq("is_available", true)
        .limit(2000)
      if (error) throw error
      return (data ?? []) as NonNullable<RawFacts["packages"]>
    }),
    // Singleton app_settings row (key IS NULL) — the same one the dashboard adjusts
    // prices from. Direct read: getPriceAdjustments() swallows errors into zeros,
    // which would cache unadjusted prices for an hour. A null column means 0%.
    source("price-adjust", FAILED_RAW.priceAdjustments, async (): Promise<PriceAdjustments | null> => {
      const { data, error } = await db
        .from("app_settings")
        .select("price_adjustment_mtn, price_adjustment_telecel, price_adjustment_at_ishare, price_adjustment_at_bigtime")
        .is("key", null)
        .maybeSingle()
      if (error) throw error
      if (!data) throw new Error("app_settings singleton row missing")
      const d = data as Record<keyof PriceAdjustments, unknown>
      const pct = (v: unknown) => {
        const n = Number(v ?? 0)
        return Number.isFinite(n) ? n : 0
      }
      return {
        price_adjustment_mtn: pct(d.price_adjustment_mtn),
        price_adjustment_telecel: pct(d.price_adjustment_telecel),
        price_adjustment_at_ishare: pct(d.price_adjustment_at_ishare),
        price_adjustment_at_bigtime: pct(d.price_adjustment_at_bigtime),
      }
    }),
    source("afa", FAILED_RAW.afaPrice, async () => {
      // Same row app/api/afa/price/route.ts shows at checkout.
      const { data, error } = await db
        .from("afa_registration_prices")
        .select("price")
        .eq("is_active", true)
        .eq("name", "default")
        .maybeSingle()
      if (error) throw error
      return positive((data as { price?: unknown } | null)?.price)
    }),
    source("airtime", { enabled: FAILED_RAW.airtimeEnabled, min: FAILED_RAW.airtimeMin }, async () => {
      // isAirtimeEnabled swallows read errors and defaults to enabled, mirroring checkout.
      const [flags, limits] = await Promise.all([Promise.all(NETS.map((n) => deps.isAirtimeEnabled(n))), deps.getAirtimeLimits()])
      return { enabled: { MTN: flags[0], Telecel: flags[1], AT: flags[2] }, min: limits.min }
    }),
    source("bills", FAILED_RAW.bills, () => getBillsConfig(db)),
    source("results", FAILED_RAW.results, () =>
      Promise.all(
        BOARDS.map(async (board) => {
          const k = board.toLowerCase()
          const [en, pr] = await Promise.all([
            readSetting(db, `results_checker_enabled_${k}`),
            readSetting(db, `results_checker_price_${k}`),
          ])
          return { board, enabled: en?.enabled !== false, price: settingNumber(pr, "price") }
        }),
      ),
    ),
    source("sms", FAILED_RAW.smsPricePerCredit, () => readSmsPricePerCredit(db)),
    // Direct read (same query as getConfig in lib/api-v2/store.ts) because getConfig
    // swallows errors, and a swallowed error must not be cached as "off" for an hour.
    source("api-v2", FAILED_RAW.apiV2Enabled, async () => {
      const { data, error } = await db.from("api_v2_config").select("enabled").eq("id", true).maybeSingle()
      if (error) throw error
      return (data as { enabled?: unknown } | null)?.enabled === true
    }),
    // readPublicUssdCodes (not getPublicUssdCodes) for the same reason: it throws on error.
    source("ussd", FAILED_RAW.ussd, () => readPublicUssdCodes(db)),
  ])

  return {
    raw: {
      packages,
      priceAdjustments,
      airtimeEnabled: airtime.enabled,
      airtimeMin: airtime.min,
      afaPrice,
      bills,
      results,
      smsPricePerCredit,
      apiV2Enabled,
      ussd,
    },
    failed,
  }
}

/** Thrown out of the cached function so a partial result is never cached. */
export class PartialFactsError extends Error {
  constructor(readonly raw: RawFacts, readonly failed: string[]) {
    super(`seo live facts: ${failed.length} source(s) failed: ${failed.join(", ")}`)
    this.name = "PartialFactsError"
  }
}

/** Throws on any failure, so unstable_cache only ever stores a complete result. */
async function loadCompleteLiveFacts(): Promise<LiveFacts> {
  const { raw, failed } = await loadRawFacts(supabaseAdmin as SupabaseClient)
  if (failed.length > 0) throw new PartialFactsError(raw, failed)
  return buildLiveFacts(raw)
}

// "v3": the cached shape gained nonExpiryPrices and failedSources; a new key so an
// entry cached by an older deploy (without them) is never served.
const cachedLiveFacts = unstable_cache(loadCompleteLiveFacts, ["seo-live-facts-v3"], {
  revalidate: 3600,
  tags: ["seo-live-facts"],
})

/** Applies the failure policy around a loader that throws on any failure. */
export async function resolveLiveFacts(load: () => Promise<LiveFacts>): Promise<LiveFacts> {
  try {
    return await load()
  } catch (e) {
    // Duck-typed as well as instanceof, in case the cache layer hands back a different Error instance.
    const pe = e as Partial<PartialFactsError> | null
    if (pe?.name === "PartialFactsError" && pe.raw && Array.isArray(pe.failed)) {
      console.error("[seo-live-facts] partial read, not cached; failed sources:", pe.failed.join(", "))
      return buildLiveFacts(pe.raw, pe.failed)
    }
    console.error("[seo-live-facts] falling back to defaults:", e instanceof Error ? e.message : "unknown error")
    return FALLBACK_FACTS
  }
}

/**
 * React cache(): one read per request, so the root layout's product-page gate,
 * generateMetadata and the page all see the same result (a partial result is
 * not in the data cache, so separate calls could otherwise disagree).
 */
export const getLiveFacts = cache((): Promise<LiveFacts> => resolveLiveFacts(cachedLiveFacts))
