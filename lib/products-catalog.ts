// lib/products-catalog.ts
import { createClient } from "@supabase/supabase-js"
import { isAirtimeEnabled, getAirtimeLimits, airtimeBaseFeeRate } from "@/lib/airtime-pricing"
import { isExamBoardEnabled, calculateRCPrice, type ExamBoard } from "@/lib/results-checker-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const AIRTIME_NETWORKS = ["MTN", "Telecel", "AT"] as const
const EXAM_BOARDS: ExamBoard[] = ["WASSCE", "BECE", "NOVDEC"]

export interface ProductsCatalogResponse {
  data_bundles: { network: string; size_gb: string; price: number }[]
  airtime: { network: string; min_amount: number; max_amount: number; fee_rate_percent: number }[]
  results_checker: { exam_board: string; unit_price: number }[]
  afa: { enabled: boolean; price: number | null }
}

/**
 * Read-only product/pricing catalog for GET /api/v1/products. Role-aware
 * (dealer price vs customer price) for data bundles; airtime/results-checker/AFA
 * pricing all live in admin_settings (or afa_registration_prices), not the
 * `packages` table, so each section reads its own source.
 */
export async function buildProductsCatalog(role: string): Promise<ProductsCatalogResponse> {
  const isDealer = role === "dealer"

  const [dataBundles, airtime, resultsChecker, afa] = await Promise.all([
    buildDataBundles(isDealer),
    buildAirtime(isDealer),
    buildResultsChecker(),
    buildAfa(),
  ])

  return { data_bundles: dataBundles, airtime, results_checker: resultsChecker, afa }
}

async function buildDataBundles(isDealer: boolean): Promise<ProductsCatalogResponse["data_bundles"]> {
  const { data, error } = await supabase
    .from("packages")
    .select("network, size, price, dealer_price")
    .eq("is_available", true)

  if (error) {
    console.error("[PRODUCTS-CATALOG] Failed to fetch packages:", error)
    return []
  }
  if (!data) return []

  return data.map((row: any) => ({
    network: row.network,
    size_gb: row.size,
    price: isDealer && Number(row.dealer_price) > 0 ? Number(row.dealer_price) : Number(row.price),
  }))
}

async function buildAirtime(isDealer: boolean): Promise<ProductsCatalogResponse["airtime"]> {
  const results: ProductsCatalogResponse["airtime"] = []
  for (const network of AIRTIME_NETWORKS) {
    const enabled = await isAirtimeEnabled(network)
    if (!enabled) continue
    const [{ min, max }, feeRate] = await Promise.all([
      getAirtimeLimits(),
      airtimeBaseFeeRate(network, isDealer),
    ])
    results.push({ network, min_amount: min, max_amount: max, fee_rate_percent: feeRate })
  }
  return results
}

async function buildResultsChecker(): Promise<ProductsCatalogResponse["results_checker"]> {
  const results: ProductsCatalogResponse["results_checker"] = []
  for (const board of EXAM_BOARDS) {
    const enabled = await isExamBoardEnabled(board)
    if (!enabled) continue
    const pricing = await calculateRCPrice({ examBoard: board, quantity: 1, applyBulk: false })
    results.push({ exam_board: board, unit_price: pricing.unitPrice })
  }
  return results
}

async function buildAfa(): Promise<ProductsCatalogResponse["afa"]> {
  const { data, error } = await supabase
    .from("afa_registration_prices")
    .select("price")
    .eq("is_active", true)
    .eq("name", "default")
    .maybeSingle()

  if (error) {
    console.error("[PRODUCTS-CATALOG] Failed to fetch AFA price:", error)
    return { enabled: false, price: null }
  }
  if (!data) return { enabled: false, price: null }
  return { enabled: true, price: parseFloat(data.price) }
}
