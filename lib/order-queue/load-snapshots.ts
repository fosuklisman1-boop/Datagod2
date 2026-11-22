import type { SupabaseClient } from "@supabase/supabase-js"
import type { OrderSnapshot } from "./eligibility"
import type { OrderType } from "./types"

/** Where each order type lives. `paidCol` set = only rows with payment_status 'completed' are real orders (as in combined_orders_view). */
export const ORDER_TABLES: Record<OrderType, { table: string; statusCol: string; paidCol: string | null }> = {
  bulk: { table: "orders", statusCol: "status", paidCol: null },
  api: { table: "api_orders", statusCol: "status", paidCol: null },
  shop: { table: "shop_orders", statusCol: "order_status", paidCol: "payment_status" },
  ussd: { table: "ussd_orders", statusCol: "order_status", paidCol: "payment_status" },
  ussd_shop: { table: "ussd_shop_orders", statusCol: "order_status", paidCol: "payment_status" },
}

const CHUNK = 100
const PAGE = 1000
const LIVE_ATTEMPT = ["pending", "processing", "completed"]
const LIVE_QUEUE = ["pending", "processing"]
const TRACKING_COLS = "id, order_id, shop_order_id, api_order_id, status, mtn_order_id, created_at"

/** Same labels as combined_orders_view (migrations/2026_05_18_add_ussd_to_combined_orders_view.sql and its ussd_shop sibling). */
export function normalizeNetwork(raw: string | null | undefined): string {
  const s = (raw ?? "").trim()
  const l = s.toLowerCase()
  if (l === "mtn") return "MTN"
  if (l === "telecel") return "Telecel"
  if (l === "at - ishare" || l === "ishare" || l === "at-ishare") return "AT - iShare"
  if (l === "at - bigtime" || l === "at-bigtime") return "AT - BigTime"
  return s
}

const chunks = <T>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, i * CHUNK + CHUNK))

/** Reads every matching row, paging so PostgREST's 1000-row cap can never hide one. Throws on any error (fail closed). */
async function readAll(build: () => any, what: string): Promise<any[]> {
  const out: any[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().order("id").range(from, from + PAGE - 1)
    if (error) throw new Error(`loadSnapshots: ${what} read failed: ${error.message}`)
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

const newer = (a: any, b: any) => {
  const ta = Date.parse(a.created_at ?? "") || 0
  const tb = Date.parse(b.created_at ?? "") || 0
  if (ta !== tb) return ta > tb
  if (typeof a.id === "number" && typeof b.id === "number") return a.id > b.id
  return String(a.id) > String(b.id)
}

/**
 * Server-side snapshot of each requested order for the bulk-send eligibility check. Reads the five order
 * tables (status + network only — never phone numbers), every mtn_fulfillment_tracking row for the orders
 * (latest attempt + live-attempt existence) and live fulfillment_queue rows, in chunks of <=100 ids.
 * Orders that do not exist, or are unpaid shop/USSD rows, are left out of the map (=> not_found).
 * Throws if any read fails, so the caller writes nothing.
 */
export async function loadSnapshots(
  db: SupabaseClient,
  orders: { id: string; type: OrderType }[],
): Promise<Map<string, OrderSnapshot>> {
  const result = new Map<string, OrderSnapshot>()
  const byType = new Map<OrderType, string[]>()
  for (const o of orders) {
    const list = byType.get(o.type) ?? []
    if (!list.includes(o.id)) list.push(o.id)
    byType.set(o.type, list)
  }

  // 1. Orders.
  for (const [type, ids] of byType) {
    const { table, statusCol, paidCol } = ORDER_TABLES[type]
    const cols = ["id", statusCol, "network", ...(paidCol ? [paidCol] : [])].join(", ")
    for (const chunk of chunks(ids)) {
      const { data, error } = await db.from(table).select(cols).in("id", chunk)
      if (error) throw new Error(`loadSnapshots: ${table} read failed: ${error.message}`)
      for (const r of (data ?? []) as any[]) {
        if (paidCol && r[paidCol] !== "completed") continue
        result.set(String(r.id), {
          id: String(r.id),
          type,
          status: r[statusCol] ?? "",
          network: normalizeNetwork(r.network),
          latestAttempt: null,
          hasLiveAttempt: false,
          queued: false,
        })
      }
    }
  }
  if (result.size === 0) return result

  // 2. Supplier attempts. Each link column is queried on its own index; order_id is also checked for
  //    shop/api ids (varchar, harmless) so a legacy row filed under order_id is never missed.
  const allIds = [...result.keys()]
  const idsOf = (t: OrderType) => allIds.filter((id) => result.get(id)!.type === t)
  const lookups: { col: string; ids: string[] }[] = [
    { col: "order_id", ids: allIds },
    { col: "shop_order_id", ids: idsOf("shop") },
    { col: "api_order_id", ids: idsOf("api") },
  ]
  const latest = new Map<string, any>()
  for (const { col, ids } of lookups) {
    for (const chunk of chunks(ids)) {
      const rows = await readAll(() => db.from("mtn_fulfillment_tracking").select(TRACKING_COLS).in(col, chunk), "tracking")
      for (const t of rows) {
        const snap = result.get(String(t[col]))
        if (!snap) continue
        const status = String(t.status ?? "").toLowerCase()
        if (LIVE_ATTEMPT.includes(status) && !String(t.mtn_order_id ?? "").startsWith("UNKNOWN_")) snap.hasLiveAttempt = true
        const cur = latest.get(snap.id)
        if (!cur || newer(t, cur)) latest.set(snap.id, t)
      }
    }
  }
  for (const [id, t] of latest) result.get(id)!.latestAttempt = { status: t.status ?? "", mtnOrderId: t.mtn_order_id ?? null }

  // 3. Already in the fulfilment queue (live rows only).
  for (const chunk of chunks(allIds)) {
    const rows = await readAll(
      () => db.from("fulfillment_queue").select("id, order_id").in("order_id", chunk).in("status", LIVE_QUEUE),
      "fulfillment_queue",
    )
    for (const q of rows) {
      const snap = result.get(String(q.order_id))
      if (snap) snap.queued = true
    }
  }

  return result
}
