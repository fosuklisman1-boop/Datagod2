/**
 * Live product facts for the public SEO surfaces: which products are on right
 * now and their lowest "from" price. buildLiveFacts() is pure; getLiveFacts()
 * reads the DB (service role) and is cached for an hour under the
 * "seo-live-facts" tag. Each source is read independently and fails closed
 * (see FAILED_RAW): switches go off, prices go null, the data catalog stays
 * on. A result with any failed source is never cached, so a DB blip neither
 * 500s a page nor advertises a dark product for an hour.
 */
import { unstable_cache } from "next/cache"
import type { SupabaseClient } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase"
import { isAirtimeEnabled, getAirtimeLimits } from "@/lib/airtime-pricing"
import { getBillsConfig, type BillsConfig } from "@/lib/bills/config"
import { BILLERS, type BillerKey } from "@/lib/bills/billers"
import { parseUssdCodes, PUBLIC_USSD_SETTING_KEY, type PublicUssdCodes } from "./ussd-codes"
import type { ProductKey } from "./products"

export interface ProductFacts {
  available: boolean
  fromPrice: number | null
  /** live networks / billers / exam boards */
  parts: string[]
}

export type LiveFacts = { products: Record<ProductKey, ProductFacts>; ussd: PublicUssdCodes }

type Net = "MTN" | "Telecel" | "AT"
type Board = "WASSCE" | "BECE" | "NOVDEC"

export interface RawFacts {
  /** null = the packages read failed (data pages stay on, no prices) */
  packages: Array<{ network: string; price: number | string | null; is_available: boolean | null }> | null
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

/**
 * packages.network values seen in code: "MTN", "Telecel", "AirtelTigo",
 * "AT-iShare" / "AT - iShare" / "AT - ISHARE", "AT-BigTime" / "AT - BigTime".
 * Every AT sub-product counts for at-data.
 */
export function networkOf(network: string): Net | null {
  const n = String(network ?? "").trim().toLowerCase()
  if (!n) return null
  if (n.startsWith("mtn")) return "MTN"
  if (n.startsWith("telecel")) return "Telecel"
  if (n.startsWith("at") || n.startsWith("airteltigo") || n.startsWith("ishare")) return "AT"
  return null
}

/** Finite, strictly positive number or null. Accepts numeric strings. */
function positive(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === "string" && v.trim() === "") return null
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

const minOf = (xs: number[]): number | null => (xs.length ? Math.min(...xs) : null)
const fact = (available: boolean, fromPrice: number | null = null, parts: string[] = []): ProductFacts => ({ available, fromPrice, parts })

export function buildLiveFacts(raw: RawFacts): LiveFacts {
  const products = {} as Record<ProductKey, ProductFacts>

  // Data — per network, lowest available positive price.
  // packages === null means the catalog read failed: keep data pages on, without prices.
  if (raw.packages === null) {
    for (const net of NETS) products[DATA_KEY[net]] = fact(true, null, [net])
  }
  const prices: Record<Net, number[]> = { MTN: [], Telecel: [], AT: [] }
  for (const row of raw.packages ?? []) {
    if (row?.is_available !== true) continue
    const net = networkOf(row.network)
    const price = positive(row.price)
    if (net && price !== null) prices[net].push(price)
  }
  for (const net of NETS) {
    if (raw.packages === null) break
    const from = minOf(prices[net])
    products[DATA_KEY[net]] = fact(from !== null, from, from !== null ? [net] : [])
  }

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

  return { products, ussd: { main: raw.ussd?.main ?? null, shop: raw.ussd?.shop ?? null } }
}

/**
 * The fail-closed value of every source, used when that source's read fails.
 * Switches go OFF (never advertise something that might be dark); the data
 * catalog stays on without prices; prices are null.
 */
export const FAILED_RAW: RawFacts = {
  packages: null,
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
export const FALLBACK_FACTS: LiveFacts = buildLiveFacts(FAILED_RAW)

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
): Promise<{ raw: RawFacts; failed: string[] }> {
  const failed: string[] = []
  async function source<T>(name: string, fallback: T, read: () => Promise<T>): Promise<T> {
    try {
      return await read()
    } catch {
      failed.push(name)
      return fallback
    }
  }

  const [packages, afaPrice, airtime, bills, results, smsPricePerCredit, apiV2Enabled, ussd] = await Promise.all([
    source("packages", FAILED_RAW.packages, async () => {
      const { data, error } = await db
        .from("packages")
        .select("network, price, is_available")
        .eq("is_available", true)
        .limit(2000)
      if (error) throw error
      return (data ?? []) as NonNullable<RawFacts["packages"]>
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
    // Direct read (same row as getPublicUssdCodes) for the same reason.
    source("ussd", FAILED_RAW.ussd, async () => {
      const { data, error } = await db.from("app_settings").select("value").eq("key", PUBLIC_USSD_SETTING_KEY).maybeSingle()
      if (error) throw error
      return parseUssdCodes((data as { value?: unknown } | null)?.value)
    }),
  ])

  return {
    raw: {
      packages,
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

const cachedLiveFacts = unstable_cache(loadCompleteLiveFacts, ["seo-live-facts"], {
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
      return buildLiveFacts(pe.raw)
    }
    console.error("[seo-live-facts] falling back to defaults:", e instanceof Error ? e.message : "unknown error")
    return FALLBACK_FACTS
  }
}

export const getLiveFacts = (): Promise<LiveFacts> => resolveLiveFacts(cachedLiveFacts)
