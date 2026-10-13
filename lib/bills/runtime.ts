import { randomBytes } from "crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"
import type { BillOrderRow, BillsDeps } from "./service"
import { BILLER_KEYS, BILLERS, isBillerKey, type BillerKey } from "./billers"
import { getBillsConfig } from "./config"

const TABLE = "hubtel_bill_orders"
const ORDER_STATUSES = ["pending", "processing", "completed", "failed", "refunded"] as const

interface RuntimeParts {
  db: SupabaseClient
  getConfig: () => Promise<{ enabled: boolean; paused: boolean; services: Record<string, boolean> }>
  client: Pick<ReturnType<typeof getHubtelCsRuntime>["client"], "query" | "purchase">
}

/** Pure wiring of BillsDeps onto a db + hubtel-cs client (separate from getBillsRuntime so tests can pass fakes). */
export function buildBillsDeps(rt: RuntimeParts, secret: string, alert: (m: string) => Promise<void>): BillsDeps {
  const { db } = rt
  return {
    getBillsConfig: () => getBillsConfig(db),
    getHubtelConfig: () => rt.getConfig(),
    query: (serviceKey, destination, params) => rt.client.query(serviceKey, destination, params),
    purchase: input => rt.client.purchase(input),
    async insertOrder(row) {
      const { data, error } = await db.from(TABLE).insert(row).select("*").single()
      if (error) throw error // 23505 (verify_token_hash reuse) is mapped to 409 by the service
      return data as BillOrderRow
    },
    async getOrder(id) {
      const { data, error } = await db.from(TABLE).select("*").eq("id", id).maybeSingle()
      if (error) throw error
      return (data as BillOrderRow | null) ?? null
    },
    async updateOrder(id, patch, onlyFromStatuses) {
      let q = db.from(TABLE).update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id)
      if (onlyFromStatuses) q = q.in("status", onlyFromStatuses)
      const { data, error } = await q.select("id")
      if (error) throw error
      return data?.length ?? 0
    },
    async debitOrder(orderId) {
      const { data, error } = await db.rpc("bill_order_debit", { p_order_id: orderId })
      if (error) throw error // outcome unknown: never map an error to a status
      if (data === "ok" || data === "insufficient" || data === "not_found") return data
      throw new Error("bill_order_debit returned an unexpected result")
    },
    alert,
    newReference: () => "BILL-" + randomBytes(6).toString("hex").toUpperCase(),
    secret,
    now: Date.now,
  }
}

export function getBillsRuntime(): { deps: BillsDeps; db: SupabaseClient } {
  const rt = getHubtelCsRuntime()
  const deps = buildBillsDeps(rt, process.env.HUBTEL_CS_CALLBACK_SECRET ?? "", async message => {
    const { notifyAdmins } = await import("@/lib/sms-service")
    await notifyAdmins(message, "bills_review", undefined, true)
  })
  return { deps, db: rt.db }
}

export interface BillsAvailability {
  enabled: boolean
  billers: { key: BillerKey; label: string; logo: string; inputHint: string; page: "bills" | "broadband"; min: number; max: number }[]
}

/** Never throws: any failure reads as "not available". */
export async function getBillsAvailability(db: SupabaseClient): Promise<BillsAvailability> {
  try {
    const cfg = await getBillsConfig(db)
    if (!cfg.enabled) return { enabled: false, billers: [] }
    const billers = BILLER_KEYS.filter(k => cfg.billers[k].enabled).map(k => {
      const d = BILLERS[k]
      return { key: k, label: d.label, logo: d.logo, inputHint: d.inputHint, page: d.page, min: cfg.billers[k].min, max: cfg.billers[k].max }
    })
    return { enabled: true, billers }
  } catch {
    return { enabled: false, billers: [] }
  }
}

export interface OrderFilters { biller?: string | null; status?: string | null; from?: string | null; to?: string | null }

const ORDER_COLUMNS =
  "id, reference_code, biller, account_number, phone, email, broadband_account, customer_name, amount, status, payment_status, failure_reason, created_at, updated_at"

/** The caller's own orders only (user_id is always filtered), newest first, max 50. Unknown filter values are ignored. */
export async function listUserBillOrders(db: SupabaseClient, userId: string, f: OrderFilters = {}) {
  let q = db.from(TABLE).select(ORDER_COLUMNS).eq("user_id", userId)
  if (f.biller && isBillerKey(f.biller)) q = q.eq("biller", f.biller)
  if (f.status && (ORDER_STATUSES as readonly string[]).includes(f.status)) q = q.eq("status", f.status)
  const from = f.from ? new Date(f.from) : null
  const to = f.to ? new Date(f.to) : null
  if (from && !Number.isNaN(from.getTime())) q = q.gte("created_at", from.toISOString())
  if (to && !Number.isNaN(to.getTime())) q = q.lte("created_at", to.toISOString())
  const { data, error } = await q.order("created_at", { ascending: false }).limit(50)
  if (error) throw error
  return data ?? []
}
