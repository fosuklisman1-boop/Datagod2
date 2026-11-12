import type { SupabaseClient } from "@supabase/supabase-js"
import { fromOrderRow, fromShopOrderRow, type OrdersRow, type ShopOrdersRow, type SupportOrder } from "@/lib/support-order"
import { resolveSupplier, type SupplierResult } from "@/lib/order-supplier"

const IN_CHUNK = 200
const THREAD_LIMIT = 300
const MESSAGE_CAP = 3000
const PREVIEW_CHARS = 140
const DAY_MS = 86_400_000

export type ThreadStatusFilter = "open" | "closed" | "all"

export interface AdminThreadUser {
  first_name: string | null
  last_name: string | null
  email: string | null
  phone_number: string | null
}

export interface AdminThreadRow {
  id: string
  user_id: string
  order_id: string | null
  shop_order_id: string | null
  subject: string
  category: string
  phone_number: string
  whatsapp_number: string
  status: "open" | "closed"
  handler: "ai" | "human"
  needs_human_at: string | null
  closed_at: string | null
  last_message_at: string
  created_at: string
  user: AdminThreadUser
  order: SupportOrder | null
  last_message: { body: string; sender_role: string; created_at: string } | null
  unread_count: number
}

export const THREAD_COLUMNS =
  "id, user_id, order_id, shop_order_id, subject, category, phone_number, whatsapp_number, status, handler, needs_human_at, closed_at, last_message_at, created_at"

const EMPTY_USER: AdminThreadUser = { first_name: null, last_name: null, email: null, phone_number: null }

function chunks<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function unique(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v))]
}

/** `days` query param: default 30, clamped to 1..90. */
export function clampDays(raw: string | null | undefined): number {
  const n = Number.parseInt(raw ?? "", 10)
  if (!Number.isFinite(n)) return 30
  return Math.min(90, Math.max(1, n))
}

async function selectIn<T>(db: SupabaseClient, table: string, columns: string, column: string, ids: string[]): Promise<T[]> {
  const rows: T[] = []
  for (const part of chunks(ids)) {
    const { data, error } = await db.from(table).select(columns).in(column, part)
    if (error) throw new Error(`${table} lookup failed`)
    rows.push(...((data ?? []) as T[]))
  }
  return rows
}

type TrackingRow = { provider: string | null; created_at: string | null; order_id: string | null; shop_order_id: string | null }
type ShopOrderWithShop = ShopOrdersRow & { shop_id: string | null; fulfillment_method: string | null }

/**
 * Order + supplier for each thread that links one. At most four kinds of query (orders,
 * shop_orders, user_shops, mtn_fulfillment_tracking); each `.in()` is chunked at 200 ids.
 */
export async function loadSupportOrders(
  db: SupabaseClient,
  threads: { id: string; order_id: string | null; shop_order_id: string | null }[],
): Promise<Map<string, { order: SupportOrder; supplier: SupplierResult }>> {
  const result = new Map<string, { order: SupportOrder; supplier: SupplierResult }>()
  const orderIds = unique(threads.map((t) => t.order_id))
  const shopOrderIds = unique(threads.map((t) => t.shop_order_id))
  if (orderIds.length === 0 && shopOrderIds.length === 0) return result

  const orders = orderIds.length
    ? await selectIn<OrdersRow>(db, "orders", "id, network, size, price, status, phone_number, order_code, created_at", "id", orderIds)
    : []
  const shopOrders = shopOrderIds.length
    ? await selectIn<ShopOrderWithShop>(
        db,
        "shop_orders",
        "id, shop_id, customer_phone, network, volume_gb, total_price, order_status, reference_code, fulfillment_method, created_at",
        "id",
        shopOrderIds,
      )
    : []
  const shopIds = unique(shopOrders.map((s) => s.shop_id))
  const shops = shopIds.length ? await selectIn<{ id: string; shop_name: string | null }>(db, "user_shops", "id, shop_name", "id", shopIds) : []
  const shopName = new Map(shops.map((s) => [s.id, s.shop_name]))

  // One tracking query per chunk of up to 200 ids across both id sets.
  const wanted = [...orders.map((o) => ({ col: "order_id", id: o.id })), ...shopOrders.map((s) => ({ col: "shop_order_id", id: s.id }))]
  const tracking: TrackingRow[] = []
  for (const part of chunks(wanted)) {
    const byCol = (col: string) => part.filter((p) => p.col === col).map((p) => p.id)
    const clauses = [byCol("order_id"), byCol("shop_order_id")]
      .map((ids, i) => (ids.length ? `${i === 0 ? "order_id" : "shop_order_id"}.in.(${ids.join(",")})` : null))
      .filter(Boolean)
      .join(",")
    const { data, error } = await db.from("mtn_fulfillment_tracking").select("provider, created_at, order_id, shop_order_id").or(clauses).order("created_at", { ascending: false }).limit(2000)
    if (error) throw new Error("tracking lookup failed")
    tracking.push(...((data ?? []) as TrackingRow[]))
  }

  const trackingFor = (col: "order_id" | "shop_order_id", id: string) => tracking.filter((t) => t[col] === id)
  const orderById = new Map(orders.map((o) => [o.id, o]))
  const shopOrderById = new Map(shopOrders.map((s) => [s.id, s]))

  for (const t of threads) {
    if (t.order_id) {
      const row = orderById.get(t.order_id)
      if (row) result.set(t.id, { order: fromOrderRow(row), supplier: resolveSupplier(trackingFor("order_id", row.id), row.status, null) })
    } else if (t.shop_order_id) {
      const row = shopOrderById.get(t.shop_order_id)
      if (row) {
        result.set(t.id, {
          order: fromShopOrderRow(row, row.shop_id ? shopName.get(row.shop_id) ?? null : null),
          supplier: resolveSupplier(trackingFor("shop_order_id", row.id), row.order_status, row.fulfillment_method),
        })
      }
    }
  }
  return result
}

export async function loadThreadUsers(db: SupabaseClient, userIds: string[]): Promise<Map<string, AdminThreadUser>> {
  const rows = await selectIn<AdminThreadUser & { id: string }>(db, "users", "id, first_name, last_name, email, phone_number", "id", unique(userIds))
  return new Map(rows.map((r) => [r.id, { first_name: r.first_name, last_name: r.last_name, email: r.email, phone_number: r.phone_number }]))
}

export async function loadAdminThreadList(
  db: SupabaseClient,
  opts: { status: ThreadStatusFilter; days: number; now?: Date },
): Promise<AdminThreadRow[]> {
  const since = new Date((opts.now ?? new Date()).getTime() - opts.days * DAY_MS).toISOString()
  let query = db.from("support_threads").select(THREAD_COLUMNS)
  if (opts.status === "open") query = query.eq("status", "open")
  else if (opts.status === "closed") query = query.eq("status", "closed").gte("last_message_at", since)
  else query = query.or(`status.eq.open,last_message_at.gte.${since}`)
  const { data, error } = await query.order("last_message_at", { ascending: false }).limit(THREAD_LIMIT)
  if (error) throw new Error("thread list failed")
  const threads = (data ?? []) as Omit<AdminThreadRow, "user" | "order" | "last_message" | "unread_count">[]
  if (threads.length === 0) return []

  const ids = threads.map((t) => t.id)
  const [users, orders] = await Promise.all([loadThreadUsers(db, threads.map((t) => t.user_id)), loadSupportOrders(db, threads)])

  const lastMessage = new Map<string, AdminThreadRow["last_message"]>()
  const unread = new Map<string, number>()
  for (const part of chunks(ids)) {
    // Capped at MESSAGE_CAP: on a very busy inbox the oldest threads in a chunk can have their unread count undercounted.
    // Newest first, so the first row seen per thread is its last message.
    const { data: msgs, error: msgError } = await db
      .from("support_messages")
      .select("thread_id, sender_role, body, created_at, read_by_admin_at")
      .in("thread_id", part)
      .order("created_at", { ascending: false })
      .limit(MESSAGE_CAP)
    if (msgError) throw new Error("message preview failed")
    for (const m of (msgs ?? []) as { thread_id: string; sender_role: string; body: string; created_at: string; read_by_admin_at: string | null }[]) {
      if (!lastMessage.has(m.thread_id)) {
        lastMessage.set(m.thread_id, { body: m.body.slice(0, PREVIEW_CHARS), sender_role: m.sender_role, created_at: m.created_at })
      }
      if (m.sender_role === "user" && !m.read_by_admin_at) unread.set(m.thread_id, (unread.get(m.thread_id) ?? 0) + 1)
    }
  }

  return threads.map((t) => ({
    ...t,
    user: users.get(t.user_id) ?? EMPTY_USER,
    order: orders.get(t.id)?.order ?? null,
    last_message: lastMessage.get(t.id) ?? null,
    unread_count: unread.get(t.id) ?? 0,
  }))
}
