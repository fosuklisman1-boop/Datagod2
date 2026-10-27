/**
 * Live product facts for the public SEO surfaces: which products are on right
 * now and their lowest "from" price. buildLiveFacts() is pure; getLiveFacts()
 * reads the DB (service role) and is cached for an hour under the
 * "seo-live-facts" tag. Any read failure falls back to FALLBACK_FACTS
 * (everything on except USSD, no prices) so a DB blip never 500s a page or
 * advertises a stale price.
 */
import { unstable_cache } from "next/cache"
import { supabaseAdmin } from "@/lib/supabase"
import { isAirtimeEnabled, getAirtimeLimits } from "@/lib/airtime-pricing"
import { getBillsConfig, type BillsConfig } from "@/lib/bills/config"
import { BILLERS, type BillerKey } from "@/lib/bills/billers"
import { getConfig } from "@/lib/api-v2/store"
import { getPublicUssdCodes, type PublicUssdCodes } from "./ussd-codes"
import { PRODUCTS, type ProductKey } from "./products"

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
  packages: Array<{ network: string; price: number | string | null; is_available: boolean | null }>
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
  const prices: Record<Net, number[]> = { MTN: [], Telecel: [], AT: [] }
  for (const row of raw.packages ?? []) {
    if (row?.is_available !== true) continue
    const net = networkOf(row.network)
    const price = positive(row.price)
    if (net && price !== null) prices[net].push(price)
  }
  for (const net of NETS) {
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

export const FALLBACK_FACTS: LiveFacts = {
  products: Object.fromEntries(
    PRODUCTS.map((p) => [p.key, fact(p.key !== "ussd")]),
  ) as Record<ProductKey, ProductFacts>,
  ussd: { main: null, shop: null },
}

/**
 * "GH₵3.50" for amounts >= 1; below 1 keep up to 3 decimals, trimming
 * trailing zeros but never below 2 ("GH₵0.025", "GH₵0.50").
 */
export function formatCedis(n: number): string {
  if (n >= 1) return `GH₵${n.toFixed(2)}`
  let s = n.toFixed(3)
  if (s.endsWith("0")) s = s.slice(0, -1)
  return `GH₵${s}`
}

// ── Loader ───────────────────────────────────────────────────────────

type Db = typeof supabaseAdmin

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

async function loadRawFacts(db: Db): Promise<RawFacts> {
  const packagesQ = db.from("packages").select("network, price, is_available").limit(2000)
  const afaQ = db
    .from("afa_registration_prices")
    .select("price")
    .eq("is_active", true)
    .eq("name", "default")
    .maybeSingle()

  const [pkgRes, afaRes, airtimeFlags, airtimeLimits, bills, resultsRows, smsSetting, apiCfg, ussd] = await Promise.all([
    packagesQ,
    afaQ,
    Promise.all(NETS.map((n) => isAirtimeEnabled(n))),
    getAirtimeLimits(),
    getBillsConfig(db),
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
    readSetting(db, "sms_price_per_credit"),
    getConfig(db),
    getPublicUssdCodes(db),
  ])

  if (pkgRes.error) throw new Error("packages read failed")
  if (afaRes.error) throw new Error("afa_registration_prices read failed")

  return {
    packages: (pkgRes.data ?? []) as RawFacts["packages"],
    airtimeEnabled: { MTN: airtimeFlags[0], Telecel: airtimeFlags[1], AT: airtimeFlags[2] },
    airtimeMin: airtimeLimits.min,
    afaPrice: positive(afaRes.data?.price),
    bills,
    results: resultsRows,
    smsPricePerCredit: settingNumber(smsSetting, "amount"),
    apiV2Enabled: apiCfg.enabled === true,
    ussd,
  }
}

export async function loadLiveFacts(): Promise<LiveFacts> {
  try {
    return buildLiveFacts(await loadRawFacts(supabaseAdmin))
  } catch (e) {
    console.error("[seo-live-facts] falling back to defaults:", e instanceof Error ? e.message : "unknown error")
    return FALLBACK_FACTS
  }
}

export const getLiveFacts: () => Promise<LiveFacts> = unstable_cache(loadLiveFacts, ["seo-live-facts"], {
  revalidate: 3600,
  tags: ["seo-live-facts"],
})
