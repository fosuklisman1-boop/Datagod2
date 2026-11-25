import { z } from "zod"
import type { CardCtx, CardLine, CatalogEntry, EntryInput } from "../types"
import { pageTitleFor } from "../pages"
import { maskPhone } from "@/lib/ai-drafts/user-label"

// Orders group: /api/admin/ orders, shop-orders, order-history, batches, sync-orders, payment-attempts,
// payment-reverify, transactions, afa-update-status. Every handler here is guarded by verifyAdminAccess
// (payment-attempts also lets an internal server call through; the assistant always goes as the admin).
//
// Left out on purpose (see EXCLUDED): orders/recover-xpress-reversals and stale-tracking/recheck. Both have
// maxDuration 300 and loop over provider calls, so they are too slow for a chat confirm card.

const uuid = z.string().uuid()
const shortText = z.string().max(100)
const dateText = z.string().max(40)
const pageNo = z.number().int().min(1).max(100000)
const limit200 = z.number().int().min(1).max(200)

const where = (page: string) => ({ page, pageTitle: pageTitleFor(page) ?? page })

const ghs = (n: unknown) => `GHS ${Number(n).toFixed(2)}`
const short = (id: unknown) => String(id ?? "").slice(0, 8)

type Card = { summary: string; lines: CardLine[] }
type Obj = Record<string, unknown>

/** Reads rows; any failure (thrown or returned) gives null so the card can fall back to the raw values. */
async function readRows(run: () => PromiseLike<{ data: unknown; error?: unknown }>): Promise<Obj[] | null> {
  try {
    const { data, error } = await run()
    if (error || !Array.isArray(data)) return null
    return data as Obj[]
  } catch {
    return null
  }
}

async function readRow(run: () => PromiseLike<{ data: unknown; error?: unknown }>): Promise<Obj | null> {
  try {
    const { data, error } = await run()
    if (error || !data || typeof data !== "object" || Array.isArray(data)) return null
    return data as Obj
  } catch {
    return null
  }
}

async function readCount(run: () => PromiseLike<{ count?: number | null; error?: unknown }>): Promise<number | null> {
  try {
    const { count, error } = await run()
    if (error || typeof count !== "number") return null
    return count
  } catch {
    return null
  }
}

function tally(values: unknown[]): string {
  const counts = new Map<string, number>()
  for (const v of values) counts.set(String(v ?? "unknown"), (counts.get(String(v ?? "unknown")) ?? 0) + 1)
  return [...counts.entries()].map(([k, n]) => `${k} x${n}`).join(", ")
}

const asBody = (i: EntryInput): Obj => (i.body ?? {}) as Obj

// ---------------------------------------------------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------------------------------------------------

async function cleanupBatchesCard(_i: EntryInput, ctx: CardCtx): Promise<Card> {
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
  const n = await readCount(() =>
    ctx.db.from("order_download_batches").select("id", { count: "exact", head: true }).eq("status", "completed").lt("created_at", cutoff),
  )
  return {
    summary: "Delete completed download batches older than 14 days",
    lines: [
      { label: "Batches to delete", value: n == null ? "All completed batches older than 14 days" : String(n) },
      { label: "Note", value: "Deleted batches cannot be re-downloaded. Orders themselves are not touched." },
    ],
  }
}

async function deleteBatchesCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const ids = Array.isArray(b.batchIds) ? (b.batchIds as string[]) : []
  const from = typeof b.fromDate === "string" ? b.fromDate : ""
  const to = typeof b.toDate === "string" ? b.toDate : ""
  const lines: CardLine[] = []
  let n: number | null = null
  if (ids.length > 0) {
    n = await readCount(() => ctx.db.from("order_download_batches").select("id", { count: "exact", head: true }).in("id", ids))
    lines.push({ label: "Batches", value: `${ids.length} chosen by id` })
  } else if (from && to) {
    n = await readCount(() =>
      ctx.db.from("order_download_batches").select("id", { count: "exact", head: true }).gte("created_at", from).lte("created_at", to),
    )
    lines.push({ label: "Created between", value: `${from} and ${to}` })
  } else if (from) {
    n = await readCount(() => ctx.db.from("order_download_batches").select("id", { count: "exact", head: true }).lt("created_at", from))
    lines.push({ label: "Created before", value: from })
  } else {
    lines.push({ label: "Problem", value: "No batch ids or dates were given, so nothing will be deleted" })
  }
  if (lines.length > 0 && (ids.length > 0 || from)) {
    lines.push({ label: "Batches to delete", value: n == null ? "Could not count them" : String(n) })
    lines.push({ label: "Note", value: "Deleted batches cannot be re-downloaded. Orders themselves are not touched." })
  }
  return { summary: "Delete download batches", lines }
}

async function shopOrderStatusCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const ids = Array.isArray(b.orderIds) ? (b.orderIds as string[]) : []
  const status = String(b.status ?? "")
  const rows = ids.length
    ? await readRows(() => ctx.db.from("shop_orders").select("id, order_status").in("id", ids))
    : []
  const lines: CardLine[] = [{ label: "Orders", value: rows ? `${rows.length} found of ${ids.length} chosen` : `${ids.length} chosen` }]
  lines.push({
    label: "Status",
    value: rows && rows.length ? `${tally(rows.map((r) => r.order_status))} -> ${status}` : `-> ${status}`,
  })
  if (status === "completed") lines.push({ label: "Money", value: "Pending shop profits on these orders are credited to the shops" })
  lines.push({ label: "Customers", value: "Notified in the app, by push and by email" })
  if (status === "failed") lines.push({ label: "Refund", value: "No refund is made by this action" })
  return { summary: `Set ${ids.length} shop order(s) to ${status}`, lines }
}

async function paymentAttemptCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const status = String(b.status ?? "")
  const id = typeof b.id === "string" ? b.id : ""
  const reference = typeof b.reference === "string" ? b.reference : ""
  const row =
    id || reference
      ? await readRow(() =>
          id
            ? ctx.db.from("payment_attempts").select("id, reference, amount, status, payment_type").eq("id", id).maybeSingle()
            : ctx.db.from("payment_attempts").select("id, reference, amount, status, payment_type").eq("reference", reference).maybeSingle(),
        )
      : null
  const lines: CardLine[] = []
  lines.push({ label: "Payment", value: row ? String(row.reference) : reference || (id ? short(id) : "No id or reference given") })
  if (row?.payment_type) lines.push({ label: "Type", value: String(row.payment_type) })
  if (row && row.amount != null) lines.push({ label: "Amount", value: ghs(row.amount) })
  lines.push({ label: "Status", value: row ? `${row.status} -> ${status}` : `-> ${status}` })
  if (status === "completed") {
    lines.push({
      label: "Money",
      value: "For a wallet top-up, credits the wallet. For a shop order, marks it paid, credits the shop's profit and sends the order to the supplier for delivery. Only if not already done.",
    })
  }
  return { summary: `Mark a payment attempt as ${status}`, lines }
}

async function reverifyCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  if (b.bulk === true) {
    const type = b.bulkType === "data" || b.bulkType === "airtime" ? (b.bulkType as string) : "all"
    const lines: CardLine[] = [{ label: "Scope", value: `Oldest pending ${type === "all" ? "data and airtime" : type} orders, up to 20 of each` }]
    if (type !== "airtime") {
      const n = await readCount(() => ctx.db.from("shop_orders").select("id", { count: "exact", head: true }).eq("payment_status", "pending"))
      if (n != null) lines.push({ label: "Pending data orders", value: String(n) })
    }
    if (type !== "data") {
      const n = await readCount(() => ctx.db.from("airtime_orders").select("id", { count: "exact", head: true }).eq("payment_status", "pending"))
      if (n != null) lines.push({ label: "Pending airtime orders", value: String(n) })
    }
    lines.push({ label: "Money", value: "Orders the payment provider confirms as paid are marked paid, shop profit is credited and delivery starts" })
    return { summary: "Re-check pending payments with the payment provider", lines }
  }
  const orderId = typeof b.orderId === "string" ? b.orderId : ""
  const orderType = b.orderType === "airtime" ? "airtime" : b.orderType === "data" ? "data" : ""
  const row = orderId && orderType
    ? await readRow(() =>
        orderType === "airtime"
          ? ctx.db.from("airtime_orders").select("id, reference_code, total_paid, payment_status").eq("id", orderId).maybeSingle()
          : ctx.db.from("shop_orders").select("id, reference_code, total_price, payment_status").eq("id", orderId).maybeSingle(),
      )
    : null
  const amount = row ? (orderType === "airtime" ? row.total_paid : row.total_price) : null
  const lines: CardLine[] = [
    { label: "Order", value: row ? String(row.reference_code) : orderId ? short(orderId) : "No order id given" },
    { label: "Type", value: orderType || "No order type given, the request will be refused" },
  ]
  if (amount != null) lines.push({ label: "Amount", value: ghs(amount) })
  if (row) lines.push({ label: "Payment status now", value: String(row.payment_status) })
  lines.push({ label: "Money", value: "If the payment provider confirms the payment, the order is marked paid, shop profit is credited and delivery starts" })
  return { summary: "Re-check one pending payment with the payment provider", lines }
}

async function afaStatusCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const id = typeof b.submissionId === "string" ? b.submissionId : ""
  const status = String(b.status ?? "")
  const row = id ? await readRow(() => ctx.db.from("afa_orders").select("status, full_name, phone_number, order_code").eq("id", id).maybeSingle()) : null
  const lines: CardLine[] = [{ label: "Registration", value: row?.order_code ? String(row.order_code) : short(id) }]
  if (row) {
    const name = typeof row.full_name === "string" ? row.full_name.trim() : ""
    const phone = typeof row.phone_number === "string" && row.phone_number.trim() ? maskPhone(row.phone_number.trim()) : ""
    const who = [name, phone].filter(Boolean).join(" · ")
    if (who) lines.push({ label: "Customer", value: who })
  }
  lines.push({ label: "Status", value: row ? `${row.status} -> ${status}` : `-> ${status}` })
  if (status === "completed" || status === "cancelled") lines.push({ label: "Customer", value: "Notified by SMS and email" })
  return { summary: `Set an AFA registration to ${status}`, lines }
}

async function batchStatusesCard(i: EntryInput): Promise<Card> {
  const b = asBody(i)
  const n = Array.isArray(b.orderIds) ? b.orderIds.length : 0
  return {
    summary: "Look up the current status of chosen orders",
    lines: [
      { label: "Orders", value: String(n) },
      { label: "Note", value: "Read only. Nothing is changed." },
    ],
  }
}

async function xpressCronCard(): Promise<Card> {
  return {
    summary: "Run the Xpress status check now",
    lines: [
      { label: "What it does", value: "Asks Xpress about recent pending and processing orders and updates their status" },
      { label: "Customers", value: "Updated orders trigger the usual status notifications" },
    ],
  }
}

async function syncOrdersCard(_i: EntryInput, ctx: CardCtx): Promise<Card> {
  // Same network test as the handler: only AT-iShare, Telecel and BigTime orders are checked, MTN is skipped.
  const CODECRAFT = ["at-ishare", "at - ishare", "telecel", "at-bigtime", "at - bigtime", "at - big time"]
  const checked = (rows: Obj[] | null): number | null =>
    rows == null
      ? null
      : rows.filter((r) => {
          const n = String(r.network ?? "").toLowerCase().trim()
          return CODECRAFT.some((k) => n.includes(k.replace("-", " ")) || n.includes(k))
        }).length
  const [a, b, c] = (
    await Promise.all([
      readRows(() => ctx.db.from("orders").select("network").eq("status", "processing")),
      readRows(() => ctx.db.from("shop_orders").select("network").eq("order_status", "processing")),
      readRows(() => ctx.db.from("api_orders").select("network").eq("status", "processing")),
    ])
  ).map(checked)
  const known = [a, b, c].every((n) => n != null)
  return {
    summary: "Check processing AT-iShare, Telecel and BigTime orders with their supplier",
    lines: [
      { label: "Orders to check", value: known ? String((a as number) + (b as number) + (c as number)) : "Count unavailable" },
      { label: "What it does", value: "Delivered orders are marked completed and failed ones are marked failed. MTN orders are skipped." },
    ],
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------------------------------------------------

const ORDER_STATUS = z.enum(["pending", "processing", "completed", "failed", "cancelled"])

export const ORDERS_ENTRIES: CatalogEntry[] = [
  // ---- lookups ----------------------------------------------------------------------------------------------------
  {
    id: "orders.history",
    area: "orders",
    ...where("/admin/order-history"),
    summary: "Show order totals (count, volume, revenue) and the list of paid orders for a date range and network.",
    method: "GET",
    path: "/api/admin/order-history",
    query: z
      .object({
        dateFrom: dateText.optional(),
        dateTo: dateText.optional(),
        network: z.string().max(40).optional(),
        limit: limit200.optional(),
        offset: z.number().int().min(0).max(1000000).optional(),
      })
      .strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    timeoutMs: 60000,
    resultKeep: [
      "stats.totalOrders",
      "stats.totalVolume",
      "stats.totalRevenue",
      "orders[].id",
      "orders[].type",
      "orders[].created_at",
      "orders[].network",
      "orders[].size",
      "orders[].price",
      "orders[].status",
      "pagination.total",
      "pagination.hasMore",
    ],
  },
  {
    id: "orders.list_all",
    area: "orders",
    ...where("/admin/order-payment-status"),
    summary: "Search every order across all order types by date, network, status, phone or payment reference.",
    method: "GET",
    path: "/api/admin/orders/all",
    query: z
      .object({
        search: shortText.optional(),
        searchType: z.enum(["all", "reference", "phone"]).optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        network: z.string().max(40).optional(),
        status: z.string().max(100).optional(),
        limit: limit200.optional(),
        offset: z.number().int().min(0).max(1000000).optional(),
      })
      .strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: [
      "count",
      "pagination.total",
      "pagination.hasMore",
      "data[].id",
      "data[].created_at",
      "data[].price",
      "data[].network",
      "data[].status",
      "data[].payment_status",
      "data[].payment_reference",
      "data[].volume_gb",
      "data[].type",
      "data[].store_name",
    ],
  },
  {
    id: "orders.all_pending",
    area: "orders",
    ...where("/admin/orders"),
    summary: "List every paid order still pending or reversed, across all order types, with a true total.",
    method: "GET",
    path: "/api/admin/orders/all-pending",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    resultKeep: ["count", "trueCount", "data[].id", "data[].type", "data[].network", "data[].size", "data[].price", "data[].status", "data[].created_at"],
  },
  {
    id: "orders.batches",
    area: "orders",
    ...where("/admin/orders"),
    summary: "List the batches of orders downloaded for supplier fulfilment.",
    method: "GET",
    path: "/api/admin/orders/batches",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    resultKeep: ["count", "data[].id", "data[].network", "data[].batch_time", "data[].order_count", "data[].status", "data[].created_at"],
  },
  {
    id: "orders.pending",
    area: "orders",
    ...where("/admin/orders"),
    summary: "List paid orders waiting to be fulfilled by hand, with counts per order type.",
    method: "GET",
    path: "/api/admin/orders/pending",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    resultKeep: [
      "count",
      "trueCount",
      "bulkCount",
      "shopCount",
      "ussdCount",
      "ussdShopCount",
      "data[].id",
      "data[].type",
      "data[].network",
      "data[].size",
      "data[].price",
      "data[].status",
      "data[].created_at",
    ],
  },
  {
    id: "orders.pending_count",
    area: "orders",
    ...where("/admin/orders"),
    summary: "Count the paid orders still pending across all order types.",
    method: "GET",
    path: "/api/admin/orders/pending-count",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["count"],
  },
  {
    id: "orders.queue",
    area: "orders",
    ...where("/admin/order-payment-status"),
    summary: "Work queue of orders that need action (needs action, held, stuck, failed, all) with the supplier's last reply and counts per view.",
    method: "GET",
    path: "/api/admin/orders/queue",
    query: z
      .object({
        view: z.enum(["needs_action", "held", "stuck", "failed", "all"]).optional(),
        statuses: z.string().max(400).optional(),
        networks: z.string().max(400).optional(),
        types: z.string().max(100).optional(),
        from: dateText.optional(),
        to: dateText.optional(),
        search: shortText.optional(),
        lastProvider: z.string().max(60).optional(),
        failureReason: z
          .enum([
            "outcome_unknown",
            "not_enabled",
            "out_of_balance",
            "rate_limited",
            "no_bundle",
            "supplier_unavailable",
            "wrong_number",
            "rejected",
            "none",
          ])
          .optional(),
        limit: limit200.optional(),
        offset: z.number().int().min(0).max(1000000).optional(),
      })
      .strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: [
      "counts",
      "total",
      "hasMore",
      "data[].id",
      "data[].createdAt",
      "data[].price",
      "data[].network",
      "data[].status",
      "data[].paymentStatus",
      "data[].paymentReference",
      "data[].volumeGb",
      "data[].type",
      "data[].storeName",
      "data[].lastProvider",
      "data[].lastAttemptStatus",
      "data[].attemptCount",
      "data[].hasReversal",
      "data[].isHeld",
      "data[].failureReason",
    ],
  },
  {
    id: "shop_orders.pending",
    area: "orders",
    ...where("/admin/orders"),
    summary: "List shop orders that are paid and still pending.",
    method: "GET",
    path: "/api/admin/shop-orders/pending",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    resultKeep: [
      "count",
      "data[].id",
      "data[].shop_id",
      "data[].network",
      "data[].size",
      "data[].price",
      "data[].base_price",
      "data[].profit_amount",
      "data[].status",
      "data[].payment_status",
      "data[].reference_code",
      "data[].created_at",
    ],
  },
  {
    id: "transactions.list",
    area: "orders",
    ...where("/admin/transactions"),
    summary: "Search wallet transactions by user, type, source, status, date or reference, with credit and debit totals.",
    method: "GET",
    path: "/api/admin/transactions",
    query: z
      .object({
        page: pageNo.optional(),
        limit: limit200.optional(),
        search: shortText.optional(),
        type: z.string().max(40).optional(),
        source: z.string().max(60).optional(),
        status: z.string().max(40).optional(),
        startDate: dateText.optional(),
        endDate: dateText.optional(),
        userId: uuid.optional(),
      })
      .strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    resultKeep: [
      "transactions[].id",
      "transactions[].user_id",
      "transactions[].user_first_name",
      "transactions[].user_last_name",
      "transactions[].type",
      "transactions[].source",
      "transactions[].status",
      "transactions[].amount",
      "transactions[].reference_id",
      "transactions[].description",
      "transactions[].created_at",
      "pagination.page",
      "pagination.totalCount",
      "pagination.totalPages",
      "stats.totalCredits",
      "stats.totalDebits",
      "stats.netFlow",
      "stats.pendingCount",
      "stats.failedCount",
      "stats.totalTransactions",
    ],
  },
  {
    id: "payment_reverify.list",
    area: "orders",
    ...where("/admin/payment-reverify"),
    summary: "List data and airtime orders whose payment is still pending and can be re-checked with the payment provider.",
    method: "GET",
    path: "/api/admin/payment-reverify",
    query: z
      .object({
        orderType: z.enum(["all", "data", "airtime"]).optional(),
        search: shortText.optional(),
        startDate: dateText.optional(),
        endDate: dateText.optional(),
        page: pageNo.optional(),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    resultKeep: [
      "orders[].id",
      "orders[].order_type",
      "orders[].reference_code",
      "orders[].wallet_reference",
      "orders[].network",
      "orders[].amount",
      "orders[].order_status",
      "orders[].status",
      "orders[].payment_status",
      "orders[].created_at",
      "stats.total",
      "stats.dataOrders",
      "stats.airtimeOrders",
      "stats.oldestPending",
      "pagination.page",
      "pagination.totalPages",
    ],
  },

  // ---- changes (including GETs that write) ------------------------------------------------------------------------
  {
    id: "payment_attempts.list",
    area: "orders",
    ...where("/admin/payment-attempts"),
    summary: "List payment attempts with totals. Opening the list also marks attempts left pending for over 10 minutes as abandoned.",
    method: "GET",
    path: "/api/admin/payment-attempts",
    query: z
      .object({
        page: pageNo.optional(),
        limit: limit200.optional(),
        search: shortText.optional(),
        status: z.enum(["pending", "completed", "failed", "abandoned"]).optional(),
        paymentType: z.string().max(40).optional(),
        startDate: dateText.optional(),
        endDate: dateText.optional(),
      })
      .strict(),
    kind: "change", // the handler runs a stale-attempt cleanup update on every GET
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    card: async (_i, _ctx) => ({
      summary: "List payment attempts",
      lines: [
        { label: "Side effect", value: "Payment attempts left pending for over 10 minutes are marked abandoned" },
        { label: "Note", value: "Nothing is credited or refunded" },
      ],
    }),
  },
  {
    id: "payment_attempts.mark",
    area: "orders",
    ...where("/admin/payment-attempts"),
    summary: "Manually set a payment attempt to completed, failed, pending or abandoned. Completed credits the wallet, or for a shop order marks it paid, credits shop profit and sends it to the supplier.",
    method: "PATCH",
    path: "/api/admin/payment-attempts",
    body: z
      .object({
        id: uuid.optional(),
        reference: z.string().min(1).max(100).optional(),
        status: z.enum(["completed", "failed", "pending", "abandoned"]),
      })
      .strict(),
    kind: "change",
    risk: "money",
    auth: "admin",
    timeoutMs: 60000,
    card: paymentAttemptCard,
  },
  {
    id: "payment_reverify.verify",
    area: "orders",
    ...where("/admin/payment-reverify"),
    summary: "Re-check one pending order's payment (or up to 20 of each kind) with the payment provider and mark confirmed ones paid.",
    method: "POST",
    path: "/api/admin/payment-reverify",
    body: z
      .object({
        orderId: uuid.optional(),
        orderType: z.enum(["data", "airtime"]).optional(),
        bulk: z.boolean().optional(),
        bulkType: z.enum(["data", "airtime", "all"]).optional(),
      })
      .strict(),
    kind: "change",
    risk: "money",
    auth: "admin",
    timeoutMs: 60000,
    card: reverifyCard,
  },
  {
    id: "afa.update_status",
    area: "orders",
    ...where("/admin/afa-management"),
    summary: "Change the status of an AFA registration. Completed or cancelled also messages the customer.",
    method: "POST",
    path: "/api/admin/afa-update-status",
    body: z
      .object({
        submissionId: uuid,
        status: z.enum(["pending", "processing", "completed", "cancelled"]),
      })
      .strict(),
    kind: "change",
    risk: "money",
    auth: "admin",
    card: afaStatusCard,
  },
  {
    id: "shop_orders.update_status",
    area: "orders",
    ...where("/admin/orders"),
    summary: "Set the status of chosen shop orders. Completed credits the shops' pending profit, and customers are notified.",
    method: "POST",
    path: "/api/admin/shop-orders/update-status",
    body: z
      .object({
        orderIds: z.array(uuid).min(1).max(200),
        status: ORDER_STATUS,
      })
      .strict(),
    kind: "change",
    risk: "money",
    auth: "admin",
    timeoutMs: 60000,
    card: shopOrderStatusCard,
  },
  {
    id: "orders.bulk_status",
    area: "orders",
    ...where("/admin/orders"),
    summary: "Set the status of many orders at once, by order ids or by date and network filters.",
    method: "POST",
    path: "/api/admin/orders/bulk-update-status",
    body: z
      .object({
        orderIds: z.array(uuid).max(5000).optional(),
        status: z.enum(["pending", "processing", "completed", "failed", "cancelled", "blacklisted", "refunded", "rejected"]),
        orderType: z.string().max(40).optional(),
        filters: z
          .object({
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
            network: z.enum(["MTN", "AirtelTigo", "Telecel", "all"]).optional(),
            startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
            endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
            onlyPending: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    kind: "change",
    risk: "money",
    auth: "admin",
    typedCard: "prepare_bulk_status_update",
  },
  {
    id: "orders.batch_statuses",
    area: "orders",
    ...where("/admin/orders"),
    summary: "Look up the current status of a list of orders by id. Read only, sent as a POST because of the list size.",
    method: "POST",
    path: "/api/admin/orders/batch-statuses",
    body: z.object({ orderIds: z.array(uuid).min(1).max(2000) }).strict(),
    kind: "change", // every POST is a change by catalog rule, even though this handler only reads
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    card: batchStatusesCard,
  },
  {
    id: "orders.delete_batches",
    area: "orders",
    ...where("/admin/orders"),
    summary: "Delete downloaded order batches by id, by a date range, or everything older than a date.",
    method: "POST",
    path: "/api/admin/orders/delete-batches",
    body: z
      .object({
        batchIds: z.array(uuid).max(500).optional(),
        fromDate: dateText.optional(),
        toDate: dateText.optional(),
      })
      .strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: deleteBatchesCard,
  },
  {
    id: "batches.cleanup_get",
    area: "orders",
    ...where("/admin/orders"),
    summary: "Delete completed download batches older than 14 days. Sent as a GET but it deletes.",
    method: "GET",
    path: "/api/admin/batches/cleanup",
    kind: "change", // the GET handler deletes rows
    risk: "danger",
    auth: "admin",
    card: cleanupBatchesCard,
  },
  {
    id: "batches.cleanup",
    area: "orders",
    ...where("/admin/orders"),
    summary: "Delete completed download batches older than 14 days.",
    method: "POST",
    path: "/api/admin/batches/cleanup",
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: cleanupBatchesCard,
  },
  {
    id: "orders.trigger_xpress_cron",
    area: "orders",
    ...where("/admin/orders/xpress-recovery"),
    summary: "Run the Xpress order status check right now instead of waiting for the schedule.",
    method: "POST",
    path: "/api/admin/orders/trigger-xpress-cron",
    kind: "change",
    risk: "money",
    auth: "admin",
    timeoutMs: 30000,
    card: xpressCronCard,
  },
  {
    id: "orders.sync_processing",
    area: "orders",
    ...where("/admin/orders"),
    summary: "Check every processing AT-iShare, Telecel and BigTime order with its supplier and update delivered or failed ones.",
    method: "POST",
    path: "/api/admin/sync-orders",
    kind: "change",
    risk: "money",
    auth: "admin",
    timeoutMs: 60000, // one supplier call plus a short pause per order; large backlogs can run longer, see the page
    card: syncOrdersCard,
  },
]
