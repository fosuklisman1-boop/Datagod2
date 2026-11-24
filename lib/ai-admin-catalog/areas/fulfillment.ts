import { z } from "zod"
import type { CardCtx, CardLine, CatalogEntry, EntryInput } from "../types"
import { pageTitleFor } from "../pages"
import { maskPhone } from "@/lib/ai-drafts/user-label"

// Fulfillment group: /api/admin/ fulfillment, auto-fulfil, mtn-registration, phone-verify,
// phone-verifications, blocked-numbers, blacklist, kuntanii, hubnet, apexprime, agentportalgh, bundleportal,
// datakazina. Every handler here is guarded by verifyAdminAccess.
//
// One entry per route+method, so provider routes that take an `action` (query or body) carry the action as a
// field of one flat strict schema and the card reads it. The schemas are deliberately NARROWER than the handlers
// where a handler action would hand a secret to the model or runs too long for a chat card:
//   - bundleportal register-webhook returns a one-time webhook secret: not in the action list.
//   - agentportalgh regenerate_secret / webhook-config GET / webhook-deliveries return secrets or raw payloads:
//     not allowed; GET only offers balance (the other actions return upstream JSON of unknown shape).
//   - kuntanii pricing and fulfillment sync-status sync_all_pending call a supplier in a loop or return upstream
//     JSON of unknown shape: use the page.
//   - no input anywhere in this group is a key or secret, so no entry needs secretFields.
//
// Left out on purpose (see EXCLUDED): afa-registrations (one auth lookup per row), afa-fulfillment, mtn-whitelist/batch-verify, blocked-numbers/check-all and
// /recheck (all maxDuration 300), fulfillment/bulk-manual-fulfill (up to 1000 sequential supplier sends) and
// phone-verify/sessions (bare array response, which the lookup filter cannot select from).

const uuid = z.string().uuid()
const dateText = z.string().max(40)
const pageNo = z.number().int().min(1).max(100000)
const limit500 = z.number().int().min(1).max(500)
const providerName = z.string().regex(/^[a-z0-9_]{1,40}$/)
const orderType = z.enum(["bulk", "shop", "api", "ussd", "ussd_shop"])

/** The only address the assistant may register with AgentPortalGH: our own webhook route (app/api/webhooks/mtn/agentportalgh), exactly. */
const OWN_WEBHOOK_URLS = [
  "https://datagod.store/api/webhooks/mtn/agentportalgh",
  "https://www.datagod.store/api/webhooks/mtn/agentportalgh",
]
const ownWebhookUrl = z.string().refine((u) => OWN_WEBHOOK_URLS.includes(u), "url must be our own AgentPortalGH webhook address")

const where = (page: string) => ({ page, pageTitle: pageTitleFor(page) ?? page })

const ghs = (n: unknown) => `GHS ${Number(n).toFixed(2)}`
const short = (id: unknown) => String(id ?? "").slice(0, 8)

type Card = { summary: string; lines: CardLine[] }
type Obj = Record<string, unknown>

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
const asQuery = (i: EntryInput): Obj => (i.query ?? {}) as Obj
const str = (v: unknown): string => (typeof v === "string" ? v : "")

/** 024 *** 4567 from any phone-looking text; short or empty input gives "***". */
function maskAny(p: unknown): string {
  const digits = String(p ?? "").replace(/\D/g, "")
  const local = digits.startsWith("233") && digits.length === 12 ? `0${digits.slice(3)}` : digits
  return local.length >= 7 ? maskPhone(local) : "***"
}

const SIDE = {
  // Where each order type lives and the columns the cards read (never more than the card shows).
  bulk: { table: "orders", cols: "id, network, size, status, phone_number", status: "status", size: "size", phone: "phone_number", pay: null },
  api: { table: "api_orders", cols: "id, network, volume_gb, status, recipient_phone", status: "status", size: "volume_gb", phone: "recipient_phone", pay: null },
  shop: {
    table: "shop_orders",
    cols: "id, network, volume_gb, order_status, payment_status, customer_phone",
    status: "order_status",
    size: "volume_gb",
    phone: "customer_phone",
    pay: "payment_status",
  },
  ussd: {
    table: "ussd_orders",
    cols: "id, network, package_size, order_status, payment_status, recipient_phone",
    status: "order_status",
    size: "package_size",
    phone: "recipient_phone",
    pay: "payment_status",
  },
  ussd_shop: {
    table: "ussd_shop_orders",
    cols: "id, network, package_size, order_status, payment_status, recipient_phone",
    status: "order_status",
    size: "package_size",
    phone: "recipient_phone",
    pay: "payment_status",
  },
} as const
type OrderKind = keyof typeof SIDE
const kindOf = (v: unknown): OrderKind => (typeof v === "string" && v in SIDE ? (v as OrderKind) : "shop")

// ---------------------------------------------------------------------------------------------------------------------
// Cards: logs and queue
// ---------------------------------------------------------------------------------------------------------------------

async function deleteFulfillmentLogsCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const q = asQuery(i)
  const lines: CardLine[] = []
  if (q.bulk === "failed") {
    const n = await readCount(() => ctx.db.from("fulfillment_logs").select("id", { count: "exact", head: true }).eq("status", "failed"))
    lines.push({ label: "Log rows to delete", value: n == null ? "Every failed fulfilment log" : String(n) })
  } else if (typeof q.id === "string" && q.id) {
    const row = await readRow(() => ctx.db.from("fulfillment_logs").select("id, status, network, order_id").eq("id", q.id as string).maybeSingle())
    lines.push({ label: "Log row", value: row ? `${short(row.id)} · ${row.network ?? "network unknown"} · ${row.status}` : short(q.id) })
    lines.push({ label: "Log rows to delete", value: "1" })
  } else {
    lines.push({ label: "Problem", value: "No log id or bulk=failed was given, so nothing will be deleted" })
  }
  lines.push({ label: "Note", value: "Deleted log rows cannot be undone. The orders themselves are not touched and nothing is refunded." })
  return { summary: q.bulk === "failed" ? "Delete every failed fulfilment log" : "Delete one fulfilment log", lines }
}

async function deleteMtnLogsCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const q = asQuery(i)
  const lines: CardLine[] = []
  if (q.bulk === "failed") {
    const n = await readCount(() => ctx.db.from("mtn_fulfillment_tracking").select("id", { count: "exact", head: true }).in("status", ["failed", "error"]))
    lines.push({ label: "Log rows to delete", value: n == null ? "Every failed or errored MTN fulfilment log" : String(n) })
  } else if (q.bulk === "failed_init") {
    const n = await readCount(() => ctx.db.from("mtn_fulfillment_tracking").select("id", { count: "exact", head: true }).like("mtn_order_id", "FAILED_INIT%"))
    lines.push({ label: "Log rows to delete", value: n == null ? "Every placeholder row left by a failed supplier request" : String(n) })
  } else {
    lines.push({ label: "Problem", value: "bulk must be failed or failed_init, so the request will be refused" })
  }
  lines.push({
    label: "Note",
    value: "Deleted tracking rows cannot be undone. Orders are not touched, but their supplier history is lost, so check an order with the supplier before you retry it.",
  })
  return { summary: q.bulk === "failed_init" ? "Purge failed-start MTN fulfilment logs" : "Delete failed MTN fulfilment logs", lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// Cards: sending orders to suppliers
// ---------------------------------------------------------------------------------------------------------------------

async function manualFulfillCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const id = str(b.shop_order_id)
  const kind = kindOf(b.order_type)
  const s = SIDE[kind]
  const provider = str(b.provider)
  const row = id ? await readRow(() => ctx.db.from(s.table).select(s.cols).eq("id", id).maybeSingle()) : null
  const lines: CardLine[] = [{ label: "Order", value: `${kind} order ${row ? short(row.id) : id ? short(id) : "(no id given, the request will be refused)"}` }]
  if (row) {
    lines.push({ label: "Network and size", value: `${row.network ?? "unknown"} · ${row[s.size] ?? "?"}` })
    lines.push({ label: "Order status now", value: String(row[s.status]) })
    if (s.pay) {
      const pay = String(row[s.pay])
      lines.push({ label: "Payment status", value: pay })
      if (pay !== "completed") {
        lines.push({ label: "Warning", value: "Payment has not been confirmed on this order, and this action does not check it. It would still buy data from the supplier." })
      }
    }
    const phone = row[s.phone]
    if (phone) lines.push({ label: "Customer number", value: maskAny(phone) })
  }
  lines.push({
    label: "Supplier",
    value: provider
      ? `Pinned to ${provider} for this order only. The backup order is skipped, so if ${provider} fails the order is not tried elsewhere.`
      : "Chosen by the saved supplier setting, with the backup order if the first supplier fails",
  })
  lines.push({
    label: "Money",
    value: "Sends the order to the supplier now, which buys the data. The order is set to processing; if the supplier fails it goes back to pending and the admins are alerted.",
  })
  lines.push({
    label: "Messages",
    value: "On success the admins get a push notice and an MTN order sends the customer a payment-confirmed text (and an email if one is on file).",
  })
  lines.push({
    label: "Refused when",
    value:
      kind === "ussd" || kind === "ussd_shop"
        ? "The order is not found. USSD orders go through the USSD fulfilment path, which forces a manual send and has its own checks; the page shows the exact outcome."
        : "The order is already completed, its number is blacklisted, or its network is not supported",
  })
  return { summary: `Send ${kind} order ${short(id)} to a supplier now`, lines }
}

async function enqueueCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const orders = Array.isArray(b.orders) ? (b.orders as Array<{ id?: unknown; type?: unknown }>) : []
  const provider = str(b.provider)
  const ack = b.riskyAck as { count?: number } | undefined
  const lines: CardLine[] = [{ label: "Orders chosen", value: String(orders.length) }]
  const byKind = new Map<OrderKind, string[]>()
  for (const o of orders) {
    const k = kindOf(o.type)
    byKind.set(k, [...(byKind.get(k) ?? []), String(o.id ?? "")])
  }
  let pending = 0
  let reversed = 0
  let known = true
  for (const [k, ids] of byKind) {
    const s = SIDE[k]
    const cols = s.pay ? `id, ${s.status}, ${s.pay}` : `id, ${s.status}`
    const rows = await readRows(() => ctx.db.from(s.table).select(cols).in("id", ids))
    if (!rows) {
      known = false
      continue
    }
    for (const r of rows) {
      const st = String(r[s.status]).toLowerCase()
      const paid = !s.pay || r[s.pay] === "completed"
      if (st === "pending" && paid) pending++
      if (st === "reversed" && paid) reversed++
    }
  }
  if (known) {
    lines.push({ label: "Look sendable (pending and paid)", value: String(pending) })
    lines.push({ label: "Reversed (need the typed acknowledgement)", value: String(reversed) })
  }
  lines.push({
    label: "Supplier",
    value: provider
      ? `Pinned to ${provider}. Orders it cannot serve for their network are refused.`
      : "No supplier chosen: the normal automatic routing picks one when each order is processed",
  })
  lines.push({
    label: "Money",
    value: "Queues each eligible order to be sent to the supplier, which buys the data. The queue is processed about every minute, so delivery starts within a minute, not instantly.",
  })
  lines.push({
    label: "Safety",
    value: "The server re-checks every order. Completed, already queued or already live-at-supplier orders are refused with a reason; held and reversed orders are released only with an acknowledgement that exactly matches the server's list, and only with a chosen supplier.",
  })
  if (ack !== undefined && !provider) {
    lines.push({ label: "Problem", value: "A held or reversed acknowledgement needs a chosen supplier, so the request will be refused and nothing queued" })
  } else if (ack !== undefined) {
    lines.push({ label: "Acknowledgement", value: `Counts ${ack.count ?? 0} held or reversed order(s). If this does not match the server's list exactly, the request is rejected and nothing is queued.` })
  }
  return { summary: `Queue ${orders.length} order(s) for sending to ${provider || "a supplier"}`, lines }
}

async function approvalPreviewCard(i: EntryInput): Promise<Card> {
  const b = asBody(i)
  const n = Array.isArray(b.orders) ? b.orders.length : 0
  return {
    summary: `Look up saved supplier approvals for ${n} order(s)`,
    lines: [
      { label: "Supplier", value: str(b.supplier) || "(none given, the request will be refused)" },
      { label: "Note", value: "Read only. Uses saved verdicts; no supplier is called and nothing is changed." },
    ],
  }
}

async function retryBlacklistedCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const id = str(b.order_id)
  const kind = b.order_type === "bulk" ? "bulk" : "shop"
  const s = SIDE[kind]
  const row = id
    ? await readRow(() => ctx.db.from(s.table).select(`${s.cols}, queue`).eq("id", id).maybeSingle())
    : null
  const lines: CardLine[] = [{ label: "Order", value: `${kind} order ${row ? short(row.id) : id ? short(id) : "(no id given)"}` }]
  if (row) {
    lines.push({ label: "Order status", value: String(row[s.status]) })
    lines.push({ label: "Queue now", value: String(row.queue ?? "unknown") })
    if (row.queue !== "blacklisted") lines.push({ label: "Problem", value: "The order is not in the blacklist queue, so the request will be refused" })
  }
  lines.push({
    label: "What it does",
    value: "Checks the customer number against the blacklist. If it is cleared, moves the order back to the normal queue; if it is still blacklisted, nothing changes.",
  })
  lines.push({ label: "Money", value: "A cleared order is then sent to a supplier on the next fulfilment cycle, which buys the data. No message is sent by this action." })
  return { summary: `Return a blacklisted ${kind} order to the normal queue`, lines }
}

async function syncStatusCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  if (typeof b.tracking_id === "string" && b.tracking_id) {
    const row = await readRow(() =>
      ctx.db.from("mtn_fulfillment_tracking").select("id, status, provider, network, size_gb, mtn_order_id").eq("id", b.tracking_id as string).maybeSingle(),
    )
    const lines: CardLine[] = [{ label: "Tracking record", value: short(b.tracking_id) }]
    if (row) {
      lines.push({ label: "Supplier", value: String(row.provider ?? "unknown") })
      lines.push({ label: "Network and size", value: `${row.network ?? "unknown"} · ${row.size_gb ?? "?"} GB` })
      lines.push({ label: "Status now", value: String(row.status) })
    }
    lines.push({ label: "What it does", value: "Asks the supplier for this order's latest status and saves it. A delivered or failed answer updates the order, with the usual status notifications." })
    return { summary: "Sync one supplier order's status", lines }
  }
  const lines: CardLine[] = [
    { label: "Order at supplier", value: str(b.mtn_order_id) || "(none given, the request will be refused)" },
    { label: "Supplier", value: str(b.provider) || "The default supplier" },
    { label: "Note", value: "Read only. Asks the supplier about this order id and shows the answer; nothing is changed." },
  ]
  return { summary: "Check one order id directly with a supplier", lines }
}

async function syncCodecraftCard(_i: EntryInput, ctx: CardCtx): Promise<Card> {
  const n = await readCount(() => ctx.db.from("fulfillment_logs").select("id", { count: "exact", head: true }).eq("status", "processing"))
  return {
    summary: "Re-check processing CodeCraft deliveries now",
    lines: [
      { label: "Logs processing now", value: n == null ? "Count unavailable" : `${n} (only those due for a re-check are asked)` },
      { label: "What it does", value: "Asks CodeCraft about AT-iShare, BigTime and Telecel deliveries still processing and saves the answers. Delivered or failed ones update the order, with the usual status notifications." },
    ],
  }
}

async function verifyWhitelistCard(i: EntryInput): Promise<Card> {
  const b = asBody(i)
  return {
    summary: "Check one number against the suppliers' allowed lists",
    lines: [
      { label: "Number", value: b.phone ? maskAny(b.phone) : "(none given, the request will be refused)" },
      { label: "Order of checks", value: str(b.primaryProvider) ? `${str(b.primaryProvider)} first, then the other configured suppliers` : "Every configured supplier in turn, stopping at the first that allows it" },
      { label: "Note", value: "Read only. Asks the suppliers; nothing is saved or changed." },
    ],
  }
}

async function mtnBalanceCard(_i: EntryInput, ctx: CardCtx): Promise<Card> {
  const row = await readRow(() => ctx.db.from("app_settings").select("value").eq("key", "mtn_balance_alert_threshold").maybeSingle())
  const level = row?.value != null ? ghs(row.value) : "the saved alert level (GHS 500 if none)"
  return {
    summary: "Check every supplier's wallet balance",
    lines: [
      { label: "What it does", value: "Asks each supplier for its wallet balance. Nothing is bought or changed." },
      { label: "Alert", value: `If any wallet is below ${level}, a low-balance alert is sent to the admins.` },
    ],
  }
}

async function syncPackagesCard(provider: "Bisdel" | "EazyGhData"): Promise<Card> {
  return {
    summary: `Refresh the saved ${provider} package list`,
    lines: [
      { label: "What it does", value: `Fetches ${provider}'s live package list and replaces the saved copy used on the settings page.` },
      { label: "Note", value: "No order is sent and no prices are changed." },
    ],
  }
}

async function bisdelCategoryCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const row = await readRow(() => ctx.db.from("admin_settings").select("value").eq("key", "bisdel_category").maybeSingle())
  const now = (row?.value as Obj | undefined)?.category
  return {
    summary: `Set the Bisdel category to ${str(b.category)}`,
    lines: [
      { label: "Category", value: `${now ? String(now) : "none set"} -> ${str(b.category)}` },
      { label: "Effect", value: "Bisdel orders are matched to products only within this category from now on. A wrong category can make Bisdel orders fail." },
    ],
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Cards: auto-fulfil, registration, number checks
// ---------------------------------------------------------------------------------------------------------------------

async function autoFulfilCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const row = await readRow(() => ctx.db.from("admin_settings").select("value").eq("key", "auto_fulfil_pending").maybeSingle())
  const old = (row?.value ?? null) as Obj | null
  const was = old?.enabled === true
  const want = b.enabled === true
  const lines: CardLine[] = [{ label: "Switch", value: `${row ? (was ? "on" : "off") : "off (never saved)"} -> ${want ? "on" : "off"}` }]
  const nets = Array.isArray(b.networks) ? (b.networks as string[]).join(", ") : ""
  lines.push({ label: "Networks", value: nets || "none" })
  lines.push({ label: "Rules", value: `Only orders older than ${b.minAgeMinutes} minutes and no older than ${b.maxAgeDays} days, up to ${b.perRun} per run` })
  if (want) {
    lines.push({
      label: "Money",
      value: "Switches on automatic sending: the system will queue pending orders and send them to suppliers on its own, buying data without anyone approving each order. Every change is written to an audit log.",
    })
  } else {
    const waiting = await readCount(() => ctx.db.from("fulfillment_queue").select("id", { count: "exact", head: true }).eq("source", "auto").eq("status", "pending"))
    lines.push({
      label: "Effect",
      value: `Switches automatic sending off and cancels the automatic queue rows still waiting (${waiting == null ? "count unavailable" : waiting}). Orders already at a supplier are not recalled.`,
    })
  }
  if (b.toggle !== true && (row ? was !== want : want)) {
    lines.push({ label: "Problem", value: "Changing the switch needs toggle set to true. Without it the request is refused so a stale settings form cannot flip the switch." })
  }
  return { summary: want ? "Save auto-fulfil settings with automatic sending ON" : "Save auto-fulfil settings with automatic sending OFF", lines }
}

async function markRegisteredCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(asBody(i).batchId)
  const batch = id ? await readRow(() => ctx.db.from("mtn_registration_batches").select("id, status, number_count").eq("id", id).maybeSingle()) : null
  const n = id
    ? await readCount(() => ctx.db.from("mtn_number_registry").select("id", { count: "exact", head: true }).eq("submitted_batch", id).eq("status", "submitted"))
    : null
  const lines: CardLine[] = [{ label: "Batch", value: batch ? `${short(batch.id)} · ${batch.status} · ${batch.number_count ?? "?"} numbers` : id ? short(id) : "(no batch id given)" }]
  lines.push({ label: "Numbers to mark registered", value: n == null ? "Every submitted number in the batch" : String(n) })
  lines.push({
    label: "Money",
    value: "Any held orders for these numbers are released at once: they are sent to the supplier (or queued for manual fulfilment), which buys the data.",
  })
  lines.push({ label: "Note", value: "The batch is marked registered and the change is written to the audit log." })
  return { summary: "Mark a downloaded registration batch as registered", lines }
}

async function releaseHeldCard(_i: EntryInput, ctx: CardCtx): Promise<Card> {
  // Same five tables and the same held status as the handler's own list route.
  const tables: Array<[string, string]> = [
    ["orders", "status"],
    ["shop_orders", "order_status"],
    ["api_orders", "status"],
    ["ussd_orders", "order_status"],
    ["ussd_shop_orders", "order_status"],
  ]
  let total = 0
  let known = true
  for (const [t, col] of tables) {
    const n = await readCount(() => ctx.db.from(t).select("id", { count: "exact", head: true }).eq(col, "held_registration"))
    if (n == null) known = false
    else total += n
  }
  return {
    summary: "Release held MTN orders whose numbers are now cleared",
    lines: [
      { label: "Orders held now", value: known ? String(total) : "Count unavailable" },
      { label: "Money", value: "Held orders whose number is confirmed registered or allowed are sent to the supplier now, which buys the data. Numbers not confirmed stay held." },
    ],
  }
}

async function phoneVerifyProcessCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(asBody(i).sessionId)
  const row = id
    ? await readRow(() => ctx.db.from("phone_verification_sessions").select("id, file_name, check_type, total_count, verified_count, status").eq("id", id).maybeSingle())
    : null
  const lines: CardLine[] = [{ label: "Check session", value: row ? `${row.file_name ?? short(row.id)} · ${row.status}` : id ? short(id) : "(no session id given)" }]
  if (row) lines.push({ label: "Progress", value: `${row.verified_count ?? 0} of ${row.total_count ?? "?"} numbers verified` })
  lines.push({
    label: "What it does",
    value: row?.check_type === "mtn_whitelist"
      ? "Checks the next batch of numbers with the suppliers' allowed lists, saves each result, and updates the saved allowed or blocked status of those numbers in the number registry."
      : "Checks the next batch of numbers and saves each result to this session.",
  })
  lines.push({ label: "Note", value: "No order is sent or changed. Run it again to continue until the session completes." })
  return { summary: "Process the next batch of a phone-number check", lines }
}

async function phoneVerificationsResetCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const all = asBody(i).all === true
  const n = await readCount(() => {
    const q = ctx.db.from("phone_otp_verifications").select("id", { count: "exact", head: true })
    return all ? q : q.eq("used", true)
  })
  return {
    summary: all ? "Clear every phone verification, including unused codes" : "Clear every verified phone number",
    lines: [
      { label: "Records to delete", value: n == null ? (all ? "All verification records" : "All verified numbers") : String(n) },
      { label: "Effect", value: "Every affected customer must re-verify their payment number by code on their next order. The reset takes effect immediately and cannot be undone." },
      ...(all ? [{ label: "Also", value: "Codes sent but not yet used are deleted too, so customers mid-verification must ask for a new code." }] : []),
      { label: "Note", value: "The reset is written to the security log." },
    ],
  }
}

async function blockedUpdateCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const id = str(b.id)
  const row = id ? await readRow(() => ctx.db.from("mtn_blocked_numbers").select("id, status").eq("id", id).maybeSingle()) : null
  const handle = b.action === "handle"
  const lines: CardLine[] = [{ label: "Blocked number", value: id ? short(id) : "(no id given)" }]
  lines.push({ label: "Status", value: `${row ? String(row.status) : "unknown"} -> ${handle ? "handled" : "blocked (re-opened)"}` })
  if (handle) {
    if (!str(b.note).trim()) lines.push({ label: "Problem", value: "A note is required to mark a number handled, so the request will be refused" })
    else lines.push({ label: "Note", value: str(b.note) })
    lines.push({ label: "Allowed from", value: "Only numbers currently blocked or expired can be marked handled" })
  } else {
    lines.push({ label: "Effect", value: "The number is re-checked with the suppliers at the next check and its keep-until date is extended. Only handled or expired numbers can be re-opened." })
  }
  lines.push({ label: "Customers", value: "No message is sent by this action" })
  return { summary: handle ? "Mark a blocked number as handled" : "Re-open a blocked number", lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// Cards: blacklist
// ---------------------------------------------------------------------------------------------------------------------

async function blacklistAddCard(i: EntryInput): Promise<Card> {
  const b = asBody(i)
  const nums = str(b.phone_number).split(/\s+/).filter(Boolean)
  return {
    summary: `Add ${nums.length} number(s) to the blacklist`,
    lines: [
      { label: "Numbers", value: nums.length ? `${nums.length}: ${nums.slice(0, 3).map(maskAny).join(", ")}${nums.length > 3 ? ", ..." : ""}` : "(none given, the request will be refused)" },
      { label: "Reason", value: str(b.reason) || "none" },
      { label: "Effect", value: "Orders for a blacklisted number are not sent to a supplier, and manual fulfilment refuses them. Orders already sent are not changed." },
    ],
  }
}

async function blacklistBulkCard(i: EntryInput): Promise<Card> {
  const b = asBody(i)
  const n = Array.isArray(b.phones) ? b.phones.length : 0
  return {
    summary: `Add ${n} number(s) to the blacklist in one go`,
    lines: [
      { label: "Numbers", value: String(n) },
      { label: "Reason", value: str(b.reason) || "Bulk import" },
      { label: "Effect", value: "Orders for a blacklisted number are not sent to a supplier, and manual fulfilment refuses them. Numbers already listed are skipped. Orders already sent are not changed." },
    ],
  }
}

async function blacklistRemoveCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const phone = str(asQuery(i).phone)
  // Same two number formats as the handler (with and without the leading 0).
  const cleaned = phone.replace(/\D/g, "")
  const lines: CardLine[] = [{ label: "Number", value: maskAny(phone) }]
  if (!cleaned) {
    lines.push({ label: "Problem", value: "No usable number was given, so nothing will change" })
    return { summary: "Remove a number from the blacklist", lines }
  }
  const withoutZero = cleaned.startsWith("0") ? cleaned.substring(1) : cleaned
  const withZero = cleaned.startsWith("0") ? cleaned : `0${cleaned}`
  const formats = [withoutZero, withZero]
  const listed = await readCount(() => ctx.db.from("blacklisted_phone_numbers").select("id", { count: "exact", head: true }).in("phone_number", formats))
  const shop = await readRows(() => ctx.db.from("shop_orders").select("id, payment_status").in("customer_phone", formats).eq("order_status", "blacklisted"))
  const wallet = await readRows(() => ctx.db.from("orders").select("id, payment_status").in("phone_number", formats).eq("status", "blacklisted"))
  lines.push({ label: "Listed entries removed", value: listed == null ? "Every entry for this number" : String(listed) })
  lines.push({ label: "Shop orders reset to pending", value: shop ? String(shop.length) : "Every blacklisted shop order for this number" })
  lines.push({ label: "Wallet orders reset to pending", value: wallet ? String(wallet.length) : "Every blacklisted wallet order for this number" })
  if (shop && wallet) {
    const paid = [...shop, ...wallet].filter((r) => r.payment_status === "completed").length
    lines.push({ label: "Sent to supplier", value: `${paid} paid order(s) are sent to a supplier right away, which buys the data. Unpaid ones are only reset.` })
    lines.push({ label: "Customers texted", value: `${shop.length + wallet.length} SMS ("cleared for fulfilment"), one per order reset` })
  } else {
    lines.push({ label: "Sent to supplier", value: "Paid orders that were blacklisted are sent to a supplier right away, which buys the data" })
    lines.push({ label: "Customers texted", value: "One SMS per order reset" })
  }
  return { summary: "Remove a number from the blacklist and release its orders", lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// Cards: provider routes
// ---------------------------------------------------------------------------------------------------------------------

async function readSetting(ctx: CardCtx, key: string, field: string): Promise<string | null> {
  const row = await readRow(() => ctx.db.from("admin_settings").select("value").eq("key", key).maybeSingle())
  const v = (row?.value as Obj | undefined)?.[field]
  return typeof v === "string" ? v : null
}

const APEX_KEYS: Record<string, string> = {
  MTN: "apexprime_mtn_fulfillment_path",
  Telecel: "apexprime_telecel_fulfillment_path",
  AirtelTigo: "apexprime_ishare_fulfillment_path",
}

async function kuntaniiPostCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  if (b.action === "set-delivery-mode") {
    const now = await readSetting(ctx, "kuntanii_delivery_mode", "mode")
    return {
      summary: `Set Kuntanii delivery mode to ${str(b.mode)}`,
      lines: [
        { label: "Delivery mode", value: `${now ?? "normal (default)"} -> ${str(b.mode) || "(none given, the request will be refused)"}` },
        { label: "Effect", value: "Changes how every new Kuntanii order is delivered from now on. Orders already sent are not changed." },
      ],
    }
  }
  if (b.action === "report-not-received") {
    const id = str(b.trackingId)
    const row = id
      ? await readRow(() => ctx.db.from("mtn_fulfillment_tracking").select("id, status, provider, network, size_gb, mtn_order_id").eq("id", id).maybeSingle())
      : null
    const lines: CardLine[] = [{ label: "Order tracking record", value: row ? `${short(row.id)} · ${row.network ?? "?"} ${row.size_gb ?? "?"} GB · ${row.status}` : id ? short(id) : "(no tracking id given)" }]
    if (str(b.reasonCode)) lines.push({ label: "Reason code", value: str(b.reasonCode) })
    if (str(b.description)) lines.push({ label: "Description", value: str(b.description) })
    lines.push({ label: "Effect", value: "Files a not-received report with Kuntanii for this delivery and saves the report here. Only completed Kuntanii orders can be reported. It does not refund the customer or resend the data by itself." })
    lines.push({
      label: "Later effect",
      value: "If Kuntanii resolves the report with a refund, the system detects it and automatically reverses this order, so it is flagged reversed and can then be re-sent to a supplier.",
    })
    return { summary: "Report a Kuntanii order as not received", lines }
  }
  const id = str(b.reportId)
  return {
    summary: "Refresh a Kuntanii dispute",
    lines: [
      { label: "Report", value: id ? short(id) : "(no report id given, the request will be refused)" },
      { label: "Effect", value: "Asks Kuntanii for the latest status of the report and saves it. Nothing else changes." },
    ],
  }
}

async function hubnetCard(): Promise<Card> {
  return {
    summary: "Check the Hubnet wallet balance",
    lines: [
      { label: "What it does", value: "Asks Hubnet for the wallet balance and whether it is in live or test mode. Nothing is bought or changed." },
    ],
  }
}

async function apexGetCard(i: EntryInput): Promise<Card> {
  const a = str(asQuery(i).action)
  return {
    summary: a === "transactions" ? "List Apex Prime wallet transactions" : a === "fulfillment-paths" ? "Show the Apex Prime delivery paths" : "Check the Apex Prime wallet balance",
    lines: [
      {
        label: "What it does",
        value: a === "fulfillment-paths" ? "Reads the saved delivery path for each network. Nothing is changed." : "Asks Apex Prime for the information. Nothing is bought or changed.",
      },
    ],
  }
}

async function apexPostCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  if (b.action === "verify") {
    return {
      summary: "Check one number with Apex Prime",
      lines: [
        { label: "Number", value: b.phone ? maskAny(b.phone) : "(none given, the request will be refused)" },
        { label: "Network", value: str(b.network) || "MTN" },
        { label: "Effect", value: "Asks Apex Prime whether the number can receive data. No order is sent and nothing is saved." },
      ],
    }
  }
  const network = str(b.network)
  const now = APEX_KEYS[network] ? await readSetting(ctx, APEX_KEYS[network], "path") : null
  return {
    summary: `Set the Apex Prime delivery path for ${network || "a network"} to ${str(b.path)}`,
    lines: [
      { label: "Network", value: network || "(none given, the request will be refused)" },
      { label: "Delivery path", value: `${now ?? "groupshare (default)"} -> ${str(b.path) || "(none given)"}` },
      { label: "Effect", value: "All new Apex Prime orders for this network use the chosen path. A path the account cannot use makes those orders fail." },
    ],
  }
}

async function routeCard(provider: string, key: string, now: string | null, next: string): Promise<Card> {
  void key
  return {
    summary: `Set the ${provider} MTN route to ${next}`,
    lines: [
      { label: "MTN route", value: `${now ?? "default"} -> ${next || "(none given, the request will be refused)"}` },
      { label: "Effect", value: `All new MTN orders sent to ${provider} use this route from now on. A route the account cannot use makes those orders fail.` },
    ],
  }
}

async function bundleportalGetCard(i: EntryInput): Promise<Card> {
  const a = str(asQuery(i).action)
  return {
    summary: a === "mtn-route" ? "Show the Bundle Portal MTN route" : "Check the Bundle Portal wallet balance",
    lines: [{ label: "What it does", value: a === "mtn-route" ? "Reads the saved route. Nothing is changed." : "Asks Bundle Portal for the wallet balance. Nothing is bought or changed." }],
  }
}

async function bundleportalPostCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  if (b.action === "verify") {
    return {
      summary: "Check one number with Bundle Portal",
      lines: [
        { label: "Number", value: b.phone ? maskAny(b.phone) : "(none given, the request will be refused)" },
        { label: "Network", value: str(b.network) || "mtn" },
        { label: "Effect", value: "Asks Bundle Portal whether the number can receive data. No order is sent and nothing is saved." },
      ],
    }
  }
  return routeCard("Bundle Portal", "bundleportal_mtn_route", await readSetting(ctx, "bundleportal_mtn_route", "route"), str(b.route))
}

async function agentportalghGetCard(): Promise<Card> {
  return {
    summary: "Check the AgentPortalGH wallet balance",
    lines: [{ label: "What it does", value: "Asks AgentPortalGH for the wallet balance. Nothing is bought or changed." }],
  }
}

async function agentportalghPostCard(i: EntryInput): Promise<Card> {
  const action = str(asQuery(i).action)
  const b = asBody(i)
  if (action === "topup") {
    return {
      summary: `Top up the AgentPortalGH wallet with ${ghs(b.amount)}`,
      lines: [
        { label: "Amount", value: ghs(b.amount) },
        { label: "Paid from", value: `${maskAny(b.phone)} on ${str(b.network) || "(no network given)"}` },
        { label: "Money", value: "Sends a MoMo payment prompt to that number. The supplier wallet is credited only after the prompt is approved on the phone, and that money leaves the paying wallet." },
      ],
    }
  }
  if (action === "preview") {
    const n = Array.isArray(b.items) ? b.items.length : 0
    return {
      summary: "Preview an AgentPortalGH order",
      lines: [
        { label: "Service", value: str(b.service) || "(none given, the request will be refused)" },
        { label: "Items", value: String(n) },
        { label: "Effect", value: "Asks AgentPortalGH what the order would cost and whether it would be accepted. Nothing is ordered." },
      ],
    }
  }
  if (action === "whitelist") {
    const n = Array.isArray(b.msisdns) ? b.msisdns.length : 0
    return {
      summary: `Check ${n} number(s) with AgentPortalGH`,
      lines: [
        { label: "Numbers", value: String(n) },
        { label: "Effect", value: "Asks AgentPortalGH whether each number is allowed. Nothing is ordered or saved." },
      ],
    }
  }
  return {
    summary: "Resend an AgentPortalGH webhook delivery",
    lines: [
      { label: "Delivery id", value: String(b.id ?? "(none given, the request will be refused)") },
      { label: "Effect", value: "AgentPortalGH sends that delivery to our webhook again. The order status in it is applied here as usual, which can mark an order delivered or failed." },
    ],
  }
}

async function agentportalghPutCard(i: EntryInput): Promise<Card> {
  const b = asBody(i)
  return {
    summary: `${b.enabled ? "Point" : "Disable"} the AgentPortalGH webhook${b.enabled ? ` at ${str(b.url)}` : ""}`,
    lines: [
      { label: "Sends delivery updates to", value: str(b.url) },
      { label: "Enabled", value: b.enabled ? "yes" : "no" },
      { label: "Effect", value: "AgentPortalGH reports order results to this address. A wrong address, or turning it off, stops delivery updates arriving, so orders can stay processing." },
      { label: "Secret", value: "The signing secret is not changed" },
    ],
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------------------------------------------------

const ORDER_REF = z.object({ id: uuid, type: orderType }).strict()

const RETRY_BUCKETS = ["rate_limited", "out_of_balance", "supplier_unavailable", "not_enabled", "no_bundle", "wrong_number", "rejected"] as const
const retryRule = z
  .object({
    retry: z.boolean(),
    waitMinutes: z.number().int().min(1).max(10080),
    maxTries: z.number().int().min(1).max(20),
  })
  .strict()

export const FULFILLMENT_ENTRIES: CatalogEntry[] = [
  // ---- lookups ----------------------------------------------------------------------------------------------------
  {
    id: "fulfillment_logs.list",
    area: "fulfillment",
    ...where("/admin/orders"),
    summary: "List the AT-iShare, BigTime and Telecel fulfilment logs with counts per status.",
    method: "GET",
    path: "/api/admin/fulfillment/logs",
    query: z
      .object({
        status: z.enum(["all", "success", "failed", "processing", "pending"]).optional(),
        phone: z.string().max(20).optional(),
        page: pageNo.optional(),
        limit: limit500.optional(),
      })
      .strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    resultKeep: [
      "logs[].id",
      "logs[].order_id",
      "logs[].network",
      "logs[].status",
      "logs[].attempt_number",
      "logs[].max_attempts",
      "logs[].error_message",
      "logs[].created_at",
      "logs[].fulfilled_at",
      "statusCounts",
      "pagination",
    ],
  },
  {
    id: "mtn_logs.list",
    area: "fulfillment",
    ...where("/admin/mtn-logs"),
    summary: "List the orders sent to MTN suppliers, with status, supplier reply and counts per status.",
    method: "GET",
    path: "/api/admin/fulfillment/mtn-logs",
    query: z
      .object({
        status: z.enum(["all", "pending", "processing", "completed", "failed", "retrying", "unknown_outcome"]).optional(),
        search: z.string().max(40).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).max(1000000).optional(),
      })
      .strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    resultKeep: [
      "logs[].id",
      "logs[].order_type",
      "logs[].mtn_order_id",
      "logs[].status",
      "logs[].network",
      "logs[].size_gb",
      "logs[].provider",
      "logs[].external_status",
      "logs[].external_message",
      "logs[].retry_count",
      "logs[].last_retry_at",
      "logs[].created_at",
      "logs[].updated_at",
      "count",
      "summary",
      "pagination.hasMore",
    ],
  },
  {
    id: "fulfillment.queue_status",
    area: "fulfillment",
    ...where("/admin/order-payment-status"),
    summary: "Show live counts per status for one batch of orders sent to suppliers.",
    method: "GET",
    path: "/api/admin/fulfillment/queue-status",
    query: z.object({ batchId: uuid }).strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["total", "pending", "processing", "completed", "failed"],
  },
  {
    id: "fulfillment.manual_list",
    area: "fulfillment",
    ...where("/admin/orders"),
    summary: "List paid orders waiting to be fulfilled by hand (pending or reversed), across all order types.",
    method: "GET",
    path: "/api/admin/fulfillment/manual-fulfill",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    resultKeep: [
      "total",
      "orders[].id",
      "orders[].type",
      "orders[].network",
      "orders[].volume_gb",
      "orders[].order_status",
      "orders[].price",
      "orders[].created_at",
    ],
  },
  {
    id: "fulfillment.retry_blacklisted_list",
    area: "fulfillment",
    ...where("/admin/orders"),
    summary: "List orders held back because the customer's number was blacklisted, and whether it is cleared now.",
    method: "GET",
    path: "/api/admin/fulfillment/retry-blacklisted",
    query: z.object({ type: z.enum(["shop", "bulk"]).optional(), page: pageNo.optional(), limit: limit500.optional() }).strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    resultKeep: [
      "orderType",
      "orders[].id",
      "orders[].network",
      "orders[].volume_gb",
      "orders[].size",
      "orders[].order_status",
      "orders[].status",
      "orders[].created_at",
      "orders[].is_still_blacklisted",
      "orders[].can_retry",
      "stats",
      "pagination",
    ],
  },
  {
    id: "bisdel.products",
    area: "fulfillment",
    ...where("/admin/settings/mtn"),
    summary: "Show the saved Bisdel product list summary: how many products, the categories and the chosen category.",
    method: "GET",
    path: "/api/admin/fulfillment/bisdel-products",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["count", "categories", "selected_category", "synced_at"],
  },
  {
    id: "eazyghdata.packages",
    area: "fulfillment",
    ...where("/admin/settings/mtn"),
    summary: "Show when the saved EazyGhData package list was last refreshed and how many packages it holds.",
    method: "GET",
    path: "/api/admin/fulfillment/eazyghdata-packages",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["count", "synced_at"],
  },
  {
    id: "auto_fulfil.get",
    area: "fulfillment",
    ...where("/admin/order-payment-status"),
    summary: "Show the auto-fulfil settings, the two fulfilment switches, the latest run and how many automatic rows wait in the queue.",
    method: "GET",
    path: "/api/admin/auto-fulfil",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: [
      "settings.enabled",
      "settings.minAgeMinutes",
      "settings.maxAgeDays",
      "settings.perRun",
      "settings.networks",
      "settings.rules",
      "valid",
      "switches",
      "lastRun",
      "waitingAutoRows",
    ],
  },
  {
    id: "mtn_registration.list",
    area: "fulfillment",
    ...where("/admin/mtn-registration"),
    summary: "Show MTN number registration counts (pending, submitted, registered, rejected, held orders) and the 20 latest batches.",
    method: "GET",
    path: "/api/admin/mtn-registration/list",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["counts", "batches[].id", "batches[].batch_time", "batches[].number_count", "batches[].status", "batches[].registered_at"],
  },
  {
    id: "phone_verify.session",
    area: "fulfillment",
    ...where("/admin/phone-verification"),
    summary: "Show one phone-number check session: its progress and how each number came out (100 per page).",
    method: "GET",
    path: "/api/admin/phone-verify/session/:id",
    params: { id: "uuid" },
    query: z.object({ status: z.string().max(20).optional(), page: pageNo.optional() }).strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: [
      "session.id",
      "session.file_name",
      "session.total_count",
      "session.verified_count",
      "session.invalid_count",
      "session.not_applicable_count",
      "session.check_type",
      "session.status",
      "session.created_at",
      "session.completed_at",
      "results[].id",
      "results[].status",
      "results[].network",
      "results[].whitelist_provider",
      "results[].verified_at",
      "total",
      "page",
      "pages",
    ],
  },
  {
    id: "phone_verify.whitelist_availability",
    area: "fulfillment",
    ...where("/admin/phone-verification"),
    summary: "Show whether any supplier allowed-list check is configured, and which suppliers.",
    method: "GET",
    path: "/api/admin/phone-verify/whitelist-availability",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["available", "providers[].name", "providers[].configured"],
  },
  {
    id: "phone_verifications.count",
    area: "fulfillment",
    ...where("/admin/gateway"),
    summary: "Show how many customer phone numbers are currently verified by code.",
    method: "GET",
    path: "/api/admin/phone-verifications/reset",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["verified"],
  },
  {
    id: "blocked_numbers.list",
    area: "fulfillment",
    ...where("/admin/blocked-numbers"),
    summary: "List MTN numbers that suppliers refused, with status, attempts and the checkout surfaces involved; optional stats.",
    method: "GET",
    path: "/api/admin/blocked-numbers",
    query: z
      .object({
        page: pageNo.optional(),
        status: z.enum(["blocked", "allowed", "expired", "handled"]).optional(),
        surface: z.string().max(40).optional(),
        shop: uuid.optional(),
        q: z.string().max(60).optional(),
        from: dateText.optional(),
        to: dateText.optional(),
        include_stats: z.enum(["1"]).optional(),
      })
      .strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    resultKeep: [
      "rows[].id",
      "rows[].status",
      "rows[].first_blocked_at",
      "rows[].last_blocked_at",
      "rows[].attempts",
      "rows[].providers_rejected",
      "rows[].recheck_count",
      "rows[].last_rechecked_at",
      "rows[].allowed_at",
      "rows[].allowed_by",
      "rows[].handled_at",
      "rows[].notes",
      "rows[].expires_at",
      "rows[].surfaces",
      "rows[].shopNames",
      "total",
      "page",
      "pageSize",
      "stats",
    ],
  },
  {
    id: "blacklist.list",
    area: "fulfillment",
    ...where("/admin/settings"),
    summary: "List blacklisted phone numbers with the reason, optionally searching by number.",
    method: "GET",
    path: "/api/admin/blacklist",
    query: z
      .object({
        search: z.string().max(100).optional(),
        limit: limit500.optional(),
        offset: z.number().int().min(0).max(1000000).optional(),
      })
      .strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    // The blacklist is a list of phone numbers by design, so its numbers are kept (admin only, never logged).
    resultKeep: ["count", "pagination.hasMore", "data[].id", "data[].phone_number", "data[].reason", "data[].created_at"],
  },
  {
    id: "kuntanii.get",
    area: "fulfillment",
    ...where("/admin/settings/mtn"),
    summary: "Show the Kuntanii not-received reports filed for one order (needs the order's trackingId). The delivery mode is on the page.",
    method: "GET",
    path: "/api/admin/kuntanii",
    query: z.object({ action: z.literal("disputes"), trackingId: uuid }).strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: [
      "disputes[].id",
      "disputes[].tracking_id",
      "disputes[].order_reference",
      "disputes[].report_reference",
      "disputes[].data_gb",
      "disputes[].reason_code",
      "disputes[].description",
      "disputes[].dispute_status",
      "disputes[].created_at",
      "disputes[].updated_at",
      "disputes[].last_checked_at",
    ],
  },
  {
    id: "datakazina.get",
    area: "fulfillment",
    ...where("/admin/settings/mtn"),
    summary: "Show which MTN route DataKazina orders use (regular or express).",
    method: "GET",
    path: "/api/admin/datakazina",
    query: z.object({ action: z.literal("mtn-route") }).strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["success", "route"],
  },

  // ---- changes (including GETs that call a supplier) --------------------------------------------------------------
  {
    id: "fulfillment.mtn_balance",
    area: "fulfillment",
    ...where("/admin/settings/mtn"),
    summary: "Check every MTN supplier's wallet balance. Asks each supplier, and sends a low-balance alert to the admins if one is below the alert level.",
    method: "GET",
    path: "/api/admin/fulfillment/mtn-balance",
    kind: "change", // calls eleven suppliers and can send an admin alert
    risk: "normal",
    auth: "admin",
    timeoutMs: 60000,
    card: mtnBalanceCard,
  },
  {
    id: "hubnet.balance",
    area: "fulfillment",
    ...where("/admin/settings/mtn"),
    summary: "Check the Hubnet wallet balance and whether Hubnet is in live or test mode.",
    method: "GET",
    path: "/api/admin/hubnet",
    query: z.object({ action: z.literal("balance") }).strict(),
    kind: "change", // calls the supplier
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    card: hubnetCard,
  },
  {
    id: "apexprime.get",
    area: "fulfillment",
    ...where("/admin/settings/mtn"),
    summary: "Apex Prime: wallet balance, wallet transactions, or the saved delivery path per network (action balance, transactions, fulfillment-paths).",
    method: "GET",
    path: "/api/admin/apexprime",
    query: z.object({ action: z.enum(["balance", "transactions", "fulfillment-paths"]) }).strict(),
    kind: "change", // balance and transactions call the supplier
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    card: apexGetCard,
  },
  {
    id: "bundleportal.get",
    area: "fulfillment",
    ...where("/admin/settings/mtn"),
    summary: "Bundle Portal: wallet balance, or the saved MTN route (action balance or mtn-route).",
    method: "GET",
    path: "/api/admin/bundleportal",
    query: z.object({ action: z.enum(["balance", "mtn-route"]) }).strict(),
    kind: "change", // balance calls the supplier
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    card: bundleportalGetCard,
  },
  {
    id: "agentportalgh.balance",
    area: "fulfillment",
    ...where("/admin/settings/mtn"),
    summary: "Check the AgentPortalGH wallet balance. Other AgentPortalGH views are on the page.",
    method: "GET",
    path: "/api/admin/agentportalgh",
    query: z.object({ action: z.literal("balance") }).strict(),
    kind: "change", // calls the supplier
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    card: agentportalghGetCard,
  },
  {
    id: "fulfillment.manual_fulfill",
    area: "fulfillment",
    ...where("/admin/orders"),
    summary: "Send one order to a supplier now (optionally pinned to one supplier). This buys the data and does not check that payment is confirmed.",
    method: "POST",
    path: "/api/admin/fulfillment/manual-fulfill",
    body: z
      .object({
        shop_order_id: uuid,
        order_type: orderType.optional(),
        provider: providerName.optional(),
      })
      .strict(),
    kind: "change",
    risk: "money",
    auth: "admin",
    timeoutMs: 60000,
    card: manualFulfillCard,
  },
  {
    id: "fulfillment.enqueue",
    area: "fulfillment",
    ...where("/admin/order-payment-status"),
    summary: "Queue up to 200 orders to be sent to a supplier, which buys the data. The server re-checks each order; held or reversed ones need a matching acknowledgement and a chosen supplier.",
    method: "POST",
    path: "/api/admin/fulfillment/enqueue",
    body: z
      .object({
        orders: z.array(ORDER_REF).min(1).max(200),
        provider: providerName.nullable().optional(),
        riskyAck: z.object({ count: z.number().int().min(0), ids: z.array(uuid).max(200).optional() }).strict().optional(),
      })
      .strict(),
    kind: "change",
    risk: "money",
    auth: "admin",
    timeoutMs: 60000,
    card: enqueueCard,
  },
  {
    id: "fulfillment.approval_preview",
    area: "fulfillment",
    ...where("/admin/order-payment-status"),
    summary: "Look up the saved supplier approvals for up to 200 orders before a bulk send. Read only, sent as a POST because of the list size.",
    method: "POST",
    path: "/api/admin/fulfillment/approval-preview",
    body: z.object({ orders: z.array(ORDER_REF).min(1).max(200), supplier: providerName }).strict(),
    kind: "change", // every POST is a change by catalog rule, even though this handler only reads
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    card: approvalPreviewCard,
  },
  {
    id: "fulfillment.retry_blacklisted",
    area: "fulfillment",
    ...where("/admin/orders"),
    summary: "Move a blacklisted order back to the normal queue once its number is cleared, so the next fulfilment cycle sends it to a supplier.",
    method: "POST",
    path: "/api/admin/fulfillment/retry-blacklisted",
    body: z.object({ order_id: uuid, order_type: z.enum(["shop", "bulk"]).optional() }).strict(),
    kind: "change",
    risk: "money",
    auth: "admin",
    card: retryBlacklistedCard,
  },
  {
    id: "fulfillment.sync_status",
    area: "fulfillment",
    ...where("/admin/mtn-logs"),
    summary: "Ask a supplier for one order's latest status: by tracking record (saves it and can complete or fail the order), or by supplier order id (read only). Bulk sync is on the page.",
    method: "POST",
    path: "/api/admin/fulfillment/sync-status",
    body: z
      .object({
        tracking_id: uuid.optional(),
        mtn_order_id: z.string().max(100).optional(),
        provider: providerName.optional(),
      })
      .strict(),
    kind: "change",
    risk: "money",
    auth: "admin",
    timeoutMs: 30000,
    card: syncStatusCard,
  },
  {
    id: "fulfillment.sync_codecraft",
    area: "fulfillment",
    ...where("/admin/orders"),
    summary: "Re-check processing CodeCraft deliveries now instead of waiting for the schedule, updating delivered or failed orders.",
    method: "POST",
    path: "/api/admin/fulfillment/sync-codecraft",
    kind: "change",
    risk: "money",
    auth: "admin",
    timeoutMs: 60000,
    card: syncCodecraftCard,
  },
  {
    id: "fulfillment.verify_whitelist",
    area: "fulfillment",
    ...where("/admin/settings/mtn"),
    summary: "Check one number against the suppliers' allowed lists, stopping at the first that allows it. Read only.",
    method: "POST",
    path: "/api/admin/fulfillment/verify-whitelist",
    body: z.object({ phone: z.string().min(7).max(20), primaryProvider: providerName.optional() }).strict(),
    kind: "change", // every POST is a change by catalog rule; it only reads from suppliers
    risk: "normal",
    auth: "admin",
    timeoutMs: 60000,
    card: verifyWhitelistCard,
  },
  {
    id: "bisdel.sync_products",
    area: "fulfillment",
    ...where("/admin/settings/mtn"),
    summary: "Fetch Bisdel's live product list and replace the saved copy.",
    method: "POST",
    path: "/api/admin/fulfillment/bisdel-products",
    kind: "change",
    risk: "normal",
    auth: "admin",
    timeoutMs: 60000,
    card: () => syncPackagesCard("Bisdel"),
  },
  {
    id: "bisdel.set_category",
    area: "fulfillment",
    ...where("/admin/settings/mtn"),
    summary: "Choose the single Bisdel category that Bisdel orders are matched within.",
    method: "PUT",
    path: "/api/admin/fulfillment/bisdel-products",
    body: z.object({ category: z.string().min(1).max(100) }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: bisdelCategoryCard,
  },
  {
    id: "eazyghdata.sync_packages",
    area: "fulfillment",
    ...where("/admin/settings/mtn"),
    summary: "Fetch EazyGhData's live package list and replace the saved copy.",
    method: "POST",
    path: "/api/admin/fulfillment/eazyghdata-packages",
    kind: "change",
    risk: "normal",
    auth: "admin",
    timeoutMs: 60000,
    card: () => syncPackagesCard("EazyGhData"),
  },
  {
    id: "fulfillment_logs.delete",
    area: "fulfillment",
    ...where("/admin/orders"),
    summary: "Delete one fulfilment log by id, or every failed fulfilment log (bulk=failed). Cannot be undone.",
    method: "DELETE",
    path: "/api/admin/fulfillment/logs",
    query: z.object({ id: uuid.optional(), bulk: z.literal("failed").optional() }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: deleteFulfillmentLogsCard,
  },
  {
    id: "mtn_logs.delete",
    area: "fulfillment",
    ...where("/admin/mtn-logs"),
    summary: "Bulk delete MTN fulfilment logs: every failed or errored one (bulk=failed), or the placeholder rows left by failed supplier requests (bulk=failed_init). Cannot be undone.",
    method: "DELETE",
    path: "/api/admin/fulfillment/mtn-logs",
    query: z.object({ bulk: z.enum(["failed", "failed_init"]) }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: deleteMtnLogsCard,
  },
  {
    id: "auto_fulfil.update",
    area: "fulfillment",
    ...where("/admin/order-payment-status"),
    summary: "Save the auto-fulfil settings. Turning it on lets the system send pending orders to suppliers on its own; turning it off cancels the waiting automatic queue. Changing the switch needs toggle true.",
    method: "PUT",
    path: "/api/admin/auto-fulfil",
    body: z
      .object({
        enabled: z.boolean(),
        toggle: z.boolean().optional(),
        minAgeMinutes: z.number().int().min(10).max(120),
        maxAgeDays: z.number().int().min(1).max(30),
        perRun: z.number().int().min(1).max(100),
        networks: z.array(z.enum(["MTN", "Telecel", "AT - iShare", "AT - BigTime"])).min(1).max(4),
        rules: z.object(Object.fromEntries(RETRY_BUCKETS.map((b) => [b, retryRule])) as Record<(typeof RETRY_BUCKETS)[number], typeof retryRule>).strict(),
      })
      .strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    timeoutMs: 30000,
    card: autoFulfilCard,
  },
  {
    id: "mtn_registration.mark_registered",
    area: "fulfillment",
    ...where("/admin/mtn-registration"),
    summary: "Mark a downloaded registration batch as registered. Orders held for those numbers are released and sent to the supplier.",
    method: "POST",
    path: "/api/admin/mtn-registration/mark-registered",
    body: z.object({ batchId: uuid }).strict(),
    kind: "change",
    risk: "money",
    auth: "admin",
    timeoutMs: 60000,
    card: markRegisteredCard,
  },
  {
    id: "mtn_registration.release_held",
    area: "fulfillment",
    ...where("/admin/mtn-registration"),
    summary: "Release held MTN orders whose numbers are now confirmed registered or allowed, sending them to the supplier now.",
    method: "POST",
    path: "/api/admin/mtn-registration/release-held",
    kind: "change",
    risk: "money",
    auth: "admin",
    timeoutMs: 60000,
    card: releaseHeldCard,
  },
  {
    id: "phone_verify.process",
    area: "fulfillment",
    ...where("/admin/phone-verification"),
    summary: "Process the next batch of numbers in a phone-number check session. Call again until it completes.",
    method: "POST",
    path: "/api/admin/phone-verify/process",
    body: z.object({ sessionId: uuid }).strict(),
    kind: "change",
    risk: "normal",
    auth: "admin",
    timeoutMs: 60000,
    card: phoneVerifyProcessCard,
  },
  {
    id: "phone_verifications.reset",
    area: "fulfillment",
    ...where("/admin/gateway"),
    summary: "Clear customers' phone verifications so they must verify their payment number by code again (all=true also clears unused codes).",
    method: "POST",
    path: "/api/admin/phone-verifications/reset",
    body: z.object({ all: z.boolean().optional() }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: phoneVerificationsResetCard,
  },
  {
    id: "blocked_numbers.update",
    area: "fulfillment",
    ...where("/admin/blocked-numbers"),
    summary: "Mark a blocked number as handled (a note is required) or re-open a handled or expired one.",
    method: "POST",
    path: "/api/admin/blocked-numbers/update",
    body: z
      .object({
        id: uuid,
        action: z.enum(["handle", "reopen"]),
        note: z.string().max(500).optional(), // required by the handler when action is handle
      })
      .strict(),
    kind: "change",
    risk: "normal",
    auth: "admin",
    card: blockedUpdateCard,
  },
  {
    id: "blacklist.add",
    area: "fulfillment",
    ...where("/admin/settings"),
    summary: "Add one or more phone numbers (space separated) to the blacklist.",
    method: "POST",
    path: "/api/admin/blacklist",
    body: z.object({ phone_number: z.string().min(7).max(2000), reason: z.string().max(300).optional() }).strict(),
    kind: "change",
    risk: "normal",
    auth: "admin",
    card: blacklistAddCard,
  },
  {
    id: "blacklist.bulk_add",
    area: "fulfillment",
    ...where("/admin/settings"),
    summary: "Add a list of phone numbers to the blacklist in one go.",
    method: "POST",
    path: "/api/admin/blacklist/bulk",
    body: z.object({ phones: z.array(z.string().min(7).max(20)).min(1).max(1000), reason: z.string().max(300).optional() }).strict(),
    kind: "change",
    risk: "normal",
    auth: "admin",
    card: blacklistBulkCard,
  },
  {
    id: "blacklist.remove",
    area: "fulfillment",
    ...where("/admin/settings"),
    summary: "Remove a number from the blacklist. Its blacklisted orders are reset to pending, paid ones are sent to a supplier, and the customers are texted.",
    method: "DELETE",
    path: "/api/admin/blacklist",
    query: z.object({ phone: z.string().min(7).max(20) }).strict(),
    kind: "change",
    risk: "money",
    auth: "admin",
    timeoutMs: 60000,
    card: blacklistRemoveCard,
  },
  {
    id: "kuntanii.post",
    area: "fulfillment",
    ...where("/admin/settings/mtn"),
    summary: "Kuntanii: set the delivery mode (set-delivery-mode), report an order not received (report-not-received) or refresh a dispute (refresh-dispute).",
    method: "POST",
    path: "/api/admin/kuntanii",
    body: z
      .object({
        action: z.enum(["set-delivery-mode", "report-not-received", "refresh-dispute"]),
        mode: z.enum(["normal", "instant"]).optional(),
        trackingId: uuid.optional(),
        reasonCode: z.string().max(50).optional(),
        description: z.string().max(500).optional(),
        reportId: uuid.optional(),
      })
      .strict(),
    kind: "change",
    risk: "danger", // the delivery mode is a global switch for every new Kuntanii order
    auth: "admin",
    timeoutMs: 30000,
    card: kuntaniiPostCard,
  },
  {
    id: "apexprime.post",
    area: "fulfillment",
    ...where("/admin/settings/mtn"),
    summary: "Apex Prime: check one number (verify) or choose the delivery path for a network (set-fulfillment-path).",
    method: "POST",
    path: "/api/admin/apexprime",
    body: z
      .object({
        action: z.enum(["verify", "set-fulfillment-path"]),
        phone: z.string().max(20).optional(),
        network: z.enum(["MTN", "Telecel", "AirtelTigo"]).optional(),
        path: z.enum(["groupshare", "store"]).optional(),
      })
      .strict(),
    kind: "change",
    risk: "danger", // a delivery-path pin changes where every new order for that network goes
    auth: "admin",
    timeoutMs: 30000,
    card: apexPostCard,
  },
  {
    id: "bundleportal.post",
    area: "fulfillment",
    ...where("/admin/settings/mtn"),
    summary: "Bundle Portal: check one number (verify) or choose the MTN route (set-mtn-route). Registering the webhook is on the page.",
    method: "POST",
    path: "/api/admin/bundleportal",
    body: z
      .object({
        action: z.enum(["verify", "set-mtn-route"]),
        phone: z.string().max(20).optional(),
        network: z.string().max(20).optional(),
        route: z.enum(["mtn", "mtn_2", "mtn_3"]).optional(),
      })
      .strict(),
    kind: "change",
    risk: "danger", // a route pin changes where every new MTN order for this supplier goes
    auth: "admin",
    timeoutMs: 30000,
    card: bundleportalPostCard,
  },
  {
    id: "datakazina.post",
    area: "fulfillment",
    ...where("/admin/settings/mtn"),
    summary: "Choose the MTN route DataKazina orders use (regular or express).",
    method: "POST",
    path: "/api/admin/datakazina",
    body: z.object({ action: z.literal("set-mtn-route"), route: z.enum(["mtn", "mtn_express"]) }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    card: async (i, ctx) =>
      routeCard("DataKazina", "datakazina_mtn_route", await readSetting(ctx, "datakazina_mtn_route", "route"), str(asBody(i).route)),
  },
  {
    id: "agentportalgh.post",
    area: "fulfillment",
    ...where("/admin/settings/mtn"),
    summary: "AgentPortalGH: top up the supplier wallet by MoMo (topup), preview an order (preview), check numbers (whitelist) or resend a webhook delivery (webhook-resend). Choose with the action query.",
    method: "POST",
    path: "/api/admin/agentportalgh",
    query: z.object({ action: z.enum(["topup", "preview", "whitelist", "webhook-resend"]) }).strict(),
    body: z
      .object({
        amount: z.number().positive().max(50000).optional(),
        phone: z.string().max(20).optional(),
        network: z.string().max(20).optional(),
        service: z.string().max(60).optional(),
        items: z.array(z.record(z.string(), z.unknown())).max(500).optional(),
        msisdns: z.array(z.string().max(20)).max(500).optional(),
        id: z.union([z.string().regex(/^[A-Za-z0-9_-]{1,60}$/), z.number().int().positive()]).optional(),
      })
      .strict(),
    kind: "change",
    risk: "money", // topup moves money out of a MoMo wallet
    auth: "admin",
    timeoutMs: 30000,
    card: agentportalghPostCard,
  },
  {
    id: "agentportalgh.put",
    area: "fulfillment",
    ...where("/admin/settings/mtn"),
    summary: "Set the address and on/off state of the AgentPortalGH webhook that reports order results to us. The signing secret is not changed.",
    method: "PUT",
    path: "/api/admin/agentportalgh",
    query: z.object({ action: z.literal("webhook-config") }).strict(),
    body: z.object({ url: ownWebhookUrl, enabled: z.boolean() }).strict(),
    kind: "change",
    risk: "danger",
    auth: "admin",
    timeoutMs: 30000,
    card: agentportalghPutCard,
  },
]
