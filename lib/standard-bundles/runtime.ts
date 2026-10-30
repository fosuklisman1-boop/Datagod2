import { randomBytes } from "crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"
import { getPrefixValidationConfig } from "@/lib/network-prefix-config"
import type { DataOrderRow, BundlesDeps } from "./service"
import { BUNDLE_NETWORKS, NETWORK_SERVICE, type BundleNetwork } from "./categories"
import { getBundlesConfig } from "./config"
import { getCashbackConfig } from "@/lib/cashback/config"
import { getBuyerTier } from "@/lib/bills/runtime"

const TABLE = "hubtel_data_orders"

interface RuntimeParts {
  db: SupabaseClient
  getConfig: () => Promise<{ enabled: boolean; paused: boolean; services: Record<string, boolean> }>
  client: Pick<ReturnType<typeof getHubtelCsRuntime>["client"], "query" | "purchase">
}

/** Pure wiring of BundlesDeps onto a db + hubtel-cs client (separate from getBundlesRuntime so tests can pass fakes). */
export function buildBundlesDeps(
  rt: RuntimeParts,
  secret: string,
  alert: (m: string, urgent?: boolean) => Promise<void>,
  getPrefixConfig: BundlesDeps["getPrefixConfig"] = getPrefixValidationConfig,
): BundlesDeps {
  const { db } = rt
  return {
    getCashbackConfig: () => getCashbackConfig(db),
    getBuyerTier: userId => getBuyerTier(db, userId),
    getBundlesConfig: () => getBundlesConfig(db),
    getHubtelConfig: () => rt.getConfig(),
    query: (serviceKey, destination, params) => rt.client.query(serviceKey, destination, params),
    purchase: input => rt.client.purchase(input),
    getPrefixConfig,
    async findOrderByIdempotencyKey(userId, idempotencyKey) {
      const { data, error } = await db.from(TABLE).select("*").eq("user_id", userId).eq("idempotency_key", idempotencyKey).maybeSingle()
      if (error) throw error
      return (data as DataOrderRow | null) ?? null
    },
    async insertOrder(row) {
      const { data, error } = await db.from(TABLE).insert(row).select("*").single()
      if (error) throw error // PostgREST error carries code "23505" on unique violation; the service maps it
      return data as DataOrderRow
    },
    async getOrder(id) {
      const { data, error } = await db.from(TABLE).select("*").eq("id", id).maybeSingle()
      if (error) throw error
      return (data as DataOrderRow | null) ?? null
    },
    async updateOrder(id, patch, onlyFromStatuses, onlyIfPaymentStatus) {
      let q = db.from(TABLE).update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id)
      if (onlyFromStatuses) q = q.in("status", onlyFromStatuses)
      if (onlyIfPaymentStatus) q = q.eq("payment_status", onlyIfPaymentStatus)
      const { data, error } = await q.select("id")
      if (error) throw error
      return data?.length ?? 0
    },
    async debitOrder(orderId) {
      const { data, error } = await db.rpc("data_order_debit", { p_order_id: orderId })
      if (error) throw error // outcome unknown: never map an error to a status
      if (data === "ok" || data === "insufficient" || data === "not_found") return data
      throw new Error("data_order_debit returned an unexpected result")
    },
    alert,
    newReference: () => "SB-" + randomBytes(6).toString("hex").toUpperCase(),
    secret,
    now: Date.now,
  }
}

export function getBundlesRuntime(): { deps: BundlesDeps; db: SupabaseClient } {
  const rt = getHubtelCsRuntime()
  const deps = buildBundlesDeps(rt, process.env.HUBTEL_CS_CALLBACK_SECRET ?? "", async (message, urgent) => {
    const { notifyAdmins } = await import("@/lib/sms-service")
    // Urgent alerts keep the email fallback (4th arg false) so they still arrive when SMS credit is out.
    await notifyAdmins(message, "bills_review", undefined, !urgent)
  })
  return { deps, db: rt.db }
}

const LABELS: Record<BundleNetwork, string> = { MTN: "MTN", TELECEL: "Telecel", AT: "AT" }

export interface BundlesAvailability {
  enabled: boolean
  networks: { network: BundleNetwork; label: string }[]
}

/**
 * Never throws: any failure reads as "not available". Mirrors the catalog gate: bundles master + network switch, AND
 * Hubtel enabled AND the network's `data_*` service on. A pause does not hide the page (browsing is allowed while paused).
 */
export async function getBundlesAvailability(
  db: SupabaseClient,
  getHubtelConfig: BundlesDeps["getHubtelConfig"],
): Promise<BundlesAvailability> {
  const NONE: BundlesAvailability = { enabled: false, networks: [] }
  try {
    const cfg = await getBundlesConfig(db)
    if (!cfg.enabled) return NONE
    const h = await getHubtelConfig()
    if (!h?.enabled) return NONE
    const networks = BUNDLE_NETWORKS
      .filter(n => cfg.networks[n]?.enabled && h.services?.[NETWORK_SERVICE[n]] === true)
      .map(n => ({ network: n, label: LABELS[n] }))
    return networks.length > 0 ? { enabled: true, networks } : NONE
  } catch {
    return NONE
  }
}

const BASE_ORDER_COLUMNS =
  "id, reference_code, network, beneficiary_phone, bundle_display, bundle_category, amount, status, payment_status, failure_reason, created_at, updated_at"
/** Plus the Special Bundles group columns (migration 0141), so the page can show a group as one line. */
const ORDER_COLUMNS = `${BASE_ORDER_COLUMNS}, special_group_id, special_index`
const ORDERS_LIMIT = 50

type OrderListRow = { id: string; special_group_id?: string | null }

/**
 * The caller's own orders only (user_id is always filtered), newest first, max 50. When the page is full and ends
 * in a Special child, that group's other children (cut off by the limit) are appended so the group shows whole.
 * Before 0141 is applied (undefined column) it falls back to the old columns.
 */
export async function listUserDataOrders(db: SupabaseClient, userId: string) {
  const page = (cols: string) =>
    db.from(TABLE).select(cols).eq("user_id", userId).order("created_at", { ascending: false }).limit(ORDERS_LIMIT)
  let res = await page(ORDER_COLUMNS)
  if (res.error && (res.error as { code?: string }).code === "42703") res = await page(BASE_ORDER_COLUMNS)
  if (res.error) throw res.error
  const rows = (res.data ?? []) as unknown as OrderListRow[]

  const tailGroup = rows.length >= ORDERS_LIMIT ? rows[rows.length - 1]?.special_group_id : null
  if (!tailGroup) return rows
  const { data, error } = await db.from(TABLE).select(ORDER_COLUMNS).eq("user_id", userId).eq("special_group_id", tailGroup)
    .order("special_index", { ascending: true }).limit(50) // a group is at most 50 children (0141 CHECK on special_index)
  if (error || !data) return rows // the page itself is still good
  const seen = new Set(rows.map(r => r.id))
  return [...rows, ...(data as unknown as OrderListRow[]).filter(r => !seen.has(r.id))]
}

/** Explicit allow-list for buy responses: never the raw row (notes can hold raw provider error text). */
export function pickOrder(o: DataOrderRow) {
  return {
    id: o.id, reference_code: o.reference_code, network: o.network, bundle_display: o.bundle_display, amount: o.amount,
    beneficiary_phone: o.beneficiary_phone, status: o.status, payment_status: o.payment_status, created_at: o.created_at,
    faceAmount: o.amount, paidAmount: o.paid_amount ?? o.amount, cashback: o.cashback_amount ?? 0,
  }
}
