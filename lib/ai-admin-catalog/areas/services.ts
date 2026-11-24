import { z } from "zod"
import type { CardCtx, CardLine, CatalogEntry, EntryInput } from "../types"
import { pageTitleFor } from "../pages"
import { computePackagePriceUpdate, type BulkPriceUpdates } from "@/lib/bulk-package-pricing"
import { STOCK_TRACKED_NETWORKS } from "@/lib/network-stock-service"
import { USSD_VISIBILITY_SERVICES } from "@/lib/ussd-service-visibility"
import { HUBTEL_CS_SERVICE_KEYS } from "@/lib/hubtel-cs/services"
import { BILLER_KEYS } from "@/lib/bills/billers"
import { TTB_SETTING_KEYS } from "@/lib/text-to-buy/settings"
import { AIRTIME_PROVIDERS } from "@/lib/airtime-provider"

// Services group: /api/admin/ shops, ussd-shops, ussd (service-visibility), ussd-hubtel, text-to-buy, packages,
// standard-bundles, results-checker, results-check-requests, results-check-settings, utility-bills, airtime and
// hubtel-cs. Every card READS the current row (single-row selects) and states old -> new, the exact amount and
// recipient (never masked: a recipient number, meter or account is a NEW value the request writes), and every side
// effect the handler has (wallet credits, notices and SMS to customers, a purchase sent to a provider).
//
// Auth: every route here uses verifyAdminAccess (directly, or through the hubtel-cs requireAdmin wrapper or the
// text-to-buy gate) EXCEPT the five ussd-shops routes, which do their own bearer-token check (users.role = 'admin'):
// those are listed as "other". ussd-shops and results-check-requests/admin-phones need no more than that.
//
// Voucher PINs: results-checker GET inventory selects whole voucher rows (PIN and serial), so its resultKeep lists ids,
// board, status and batch only. The "deliver" action sends PINs to the customer; its card names the customer and the
// exam board and never reads a PIN or serial.
//
// Left out of lookups on purpose: customer message text and caller USSD input (text-to-buy messages return no body;
// ussd-hubtel session transcripts are EXCLUDED); raw callback payloads (callback-logs/:id keeps summary columns only).

type Card = { summary: string; lines: CardLine[] }
type Obj = Record<string, unknown>
type Read = { state: "found"; row: Obj } | { state: "missing" } | { state: "unread" }

const mk = (e: Omit<CatalogEntry, "area" | "pageTitle">): CatalogEntry => ({ ...e, area: "services", pageTitle: pageTitleFor(e.page) ?? e.page })

const uuid = z.string().uuid()
const bool = z.boolean()
const ghsNum = z.number().finite().positive().max(1_000_000)

const asBody = (i: EntryInput): Obj => (i.body ?? {}) as Obj
const asParams = (i: EntryInput): Record<string, string> => i.params ?? {}
const str = (v: unknown): string => (typeof v === "string" ? v : "")
const onOff = (b: boolean): string => (b ? "ON" : "OFF")
const ghs = (v: unknown): string => (Number.isFinite(Number(v)) && v !== null && v !== "" ? `GHS ${Number(v).toFixed(2)}` : "unknown")
const shown = (v: unknown): string => (typeof v === "string" ? (v === "" ? "(empty)" : v) : v === null || v === undefined ? "(not set)" : String(v))
const change = (a: string, b: string): string => `${a} -> ${b}`
const short = (id: string): string => (id ? id.slice(0, 8) : "(no id)")

async function readOne(run: () => PromiseLike<{ data: unknown; error?: unknown }>): Promise<Read> {
  try {
    const { data, error } = await run()
    if (error) return { state: "unread" }
    if (!data || typeof data !== "object" || Array.isArray(data)) return { state: "missing" }
    return { state: "found", row: data as Obj }
  } catch {
    return { state: "unread" }
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

const rowBy = (ctx: CardCtx, table: string, cols: string, col: string, val: string): Promise<Read> =>
  readOne(() => ctx.db.from(table).select(cols).eq(col, val).maybeSingle())

const adminSetting = (ctx: CardCtx, key: string): Promise<Read> =>
  readOne(() => ctx.db.from("admin_settings").select("value").eq("key", key).maybeSingle())

const UNREAD: CardLine = { label: "Problem", value: "The current record could not be read just now, so the old values cannot be shown." }
const MISSING: CardLine = { label: "Problem", value: "No such record was found: the request will most likely be refused." }
const noteLine = (r: Read): CardLine[] => (r.state === "unread" ? [UNREAD] : r.state === "missing" ? [MISSING] : [])
const rowOf = (r: Read): Obj | null => (r.state === "found" ? r.row : null)

// ---------------------------------------------------------------------------------------------------------------------
// Shops
// ---------------------------------------------------------------------------------------------------------------------

const SHOP_COLS = "id, shop_name, shop_slug, is_active, is_blocked, block_reason, user_id"

async function shopLines(ctx: CardCtx, shopId: string): Promise<{ lines: CardLine[]; row: Obj | null }> {
  const r = await rowBy(ctx, "user_shops", SHOP_COLS, "id", shopId)
  const row = rowOf(r)
  const lines: CardLine[] = [{ label: "Shop", value: row ? `${shown(row.shop_name)} (${short(shopId)})` : `id ${shopId}` }, ...noteLine(r)]
  if (row) lines.push({ label: "Status now", value: `${row.is_active ? "active" : "not active"}, ${row.is_blocked ? "blocked" : "not blocked"}` })
  return { lines, row }
}

const shopApproveCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const id = str(asBody(i).shopId)
  const { lines } = await shopLines(ctx, id)
  lines.push({ label: "What changes", value: "The shop becomes active (visible and able to sell). Only an inactive shop is approved: an already approved shop, or a storefront sub-agent shop that opens when its prices are set, is refused." })
  lines.push({ label: "Notices", value: "The shop owner is told it was approved: in-app notice, push, email and SMS." })
  return { summary: "Approve a shop", lines }
}

const shopRejectCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const { lines } = await shopLines(ctx, str(b.shopId))
  lines.push({ label: "Reason given to the owner", value: b.reason ? str(b.reason) : "(none)" })
  lines.push({ label: "What changes", value: "The shop is set to NOT active, even if it is live and selling right now: there is no check of its current state, so rejecting an active shop switches it off." })
  lines.push({ label: "Notices", value: "The shop owner is told it was rejected (with the reason): in-app notice, push, email and SMS." })
  return { summary: "Reject a shop (set it to not active)", lines }
}

const shopBlockCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const blocking = b.action === "block"
  const { lines } = await shopLines(ctx, str(b.shopId))
  lines.push({ label: "Action", value: blocking ? "Block the shop" : "Unblock the shop" })
  if (blocking) {
    lines.push({ label: "Reason shown to the owner", value: b.reason ? str(b.reason) : "(missing: the request is refused, a reason is required to block)" })
    lines.push({ label: "What changes", value: "The shop is marked blocked with this reason and the time; the owner cannot use it until it is unblocked." })
    lines.push({ label: "Notices", value: "The owner gets an in-app notice, a push and an SMS that the shop is temporarily blocked, including the reason." })
  } else {
    lines.push({ label: "What changes", value: "The block, its reason and its time are cleared; the shop works again." })
    lines.push({ label: "Notices", value: "The owner gets an in-app notice, a push and an SMS that the shop is unblocked." })
  }
  return { summary: blocking ? "Block a shop" : "Unblock a shop", lines }
}

const shopBalanceCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const shopId = asParams(i).shopId ?? ""
  const credit = b.type === "credit"
  const { lines } = await shopLines(ctx, shopId)
  const bal = await rowBy(ctx, "shop_available_balance", "available_balance", "shop_id", shopId)
  const cur = rowOf(bal) ? Number(rowOf(bal)!.available_balance) : bal.state === "missing" ? 0 : null
  lines.push({ label: "Adjustment", value: `${credit ? "CREDIT (adds to the shop's profit balance)" : "DEBIT (takes from the shop's profit balance)"} ${ghs(b.amount)}` })
  if (cur !== null && Number.isFinite(Number(b.amount))) {
    const after = cur + (credit ? 1 : -1) * Number(b.amount)
    lines.push({ label: "Shop balance", value: change(ghs(cur), ghs(after)) })
  } else lines.push({ label: "Shop balance", value: "unknown (could not be read just now)" })
  lines.push({ label: "Note kept on the record", value: b.notes ? str(b.notes) : `Manual ${credit ? "Credit" : "Debit"} by admin` })
  lines.push({ label: "How", value: "A manual profit record is added for the shop and the balance updates at once. This moves real money the shop can withdraw." })
  if (!credit) lines.push({ label: "No balance check", value: "A debit is not checked against the balance: it can push the shop's balance below zero." })
  return { summary: `${credit ? "Credit" : "Debit"} a shop's profit balance by ${ghs(b.amount)}`, lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// USSD shops
// ---------------------------------------------------------------------------------------------------------------------

const CODE_COLS = "id, code, status, activation_fee_paid, whatsapp_activated, shop_id"

async function codeLines(ctx: CardCtx, id: string): Promise<{ lines: CardLine[]; row: Obj | null }> {
  const r = await rowBy(ctx, "ussd_shop_codes", CODE_COLS, "id", id)
  const row = rowOf(r)
  const lines: CardLine[] = [{ label: "USSD shop code", value: row ? `${shown(row.code)} (${short(id)})` : `id ${id}` }, ...noteLine(r)]
  if (row) {
    lines.push({ label: "Now", value: `${shown(row.status)}, activation fee ${row.activation_fee_paid ? "paid" : "not paid"}, WhatsApp ${row.whatsapp_activated ? "activated" : "not activated"}` })
    const s = await rowBy(ctx, "user_shops", "shop_name", "id", str(row.shop_id))
    if (rowOf(s)) lines.push({ label: "Shop", value: shown(rowOf(s)!.shop_name) })
  }
  return { lines, row }
}

const ussdShopCreateCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const s = await rowBy(ctx, "user_shops", "shop_name", "id", str(b.shop_id))
  const lines: CardLine[] = [
    { label: "Shop", value: rowOf(s) ? `${shown(rowOf(s)!.shop_name)} (${short(str(b.shop_id))})` : `id ${str(b.shop_id)}` },
    ...noteLine(s),
    { label: "New USSD shop code", value: b.code ? str(b.code).trim() : "a unique 4-digit code picked automatically (6 digits if 4 are all taken)" },
    { label: "What changes", value: "A shop code is created for the shop. Whether it starts active or inactive is decided by the activation-fee rule of the database, not by this request. A code that is already taken is refused." },
    { label: "Notices", value: "The shop owner gets a push saying the USSD shop is ready, with the dial code and the new shop code." },
  ]
  return { summary: "Create a USSD shop code", lines }
}

const ussdShopUpdateCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const { lines, row } = await codeLines(ctx, asParams(i).id ?? "")
  if (b.code !== undefined) lines.push({ label: "Code", value: change(row ? shown(row.code) : "(unknown)", str(b.code).trim() === "" ? "(empty)" : str(b.code)) })
  if (b.status !== undefined) {
    lines.push({ label: "Status", value: change(row ? shown(row.status) : "(unknown)", str(b.status)) })
    if (b.status === "active") lines.push({ label: "Fee", value: "Setting a code active here does not record any activation-fee payment; use the activate action to mark the fee paid." })
    if (b.status !== "active") lines.push({ label: "Effect", value: "Customers can no longer buy through this shop code while it is not active." })
  }
  if (b.code === undefined && b.status === undefined) lines.push({ label: "Note", value: "Nothing to change: neither a status nor a code was sent." })
  lines.push({ label: "Notices", value: "Nobody is notified." })
  return { summary: "Change a USSD shop code", lines }
}

const ussdShopDeleteCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const id = asParams(i).id ?? ""
  const { lines } = await codeLines(ctx, id)
  const pending = await readCount(() => ctx.db.from("ussd_shop_orders").select("id", { count: "exact", head: true }).eq("shop_code_id", id).in("order_status", ["pending", "processing"]))
  lines.push({ label: "Orders still pending or processing", value: pending === null ? "unknown (could not be read just now)" : String(pending) })
  if (pending !== null && pending > 0) lines.push({ label: "Result", value: "The request is refused while orders are pending or processing." })
  lines.push({ label: "What changes", value: "The shop code is deleted for good: customers can no longer dial it and the code is free to be given out again." })
  return { summary: "Delete a USSD shop code", lines }
}

const ussdActivateCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const { lines, row } = await codeLines(ctx, asParams(i).id ?? "")
  if (row?.activation_fee_paid) lines.push({ label: "Result", value: "Already activated: the request is refused." })
  lines.push({ label: "What changes", value: "The code is set active and the activation fee is marked PAID without any payment (recorded as a manual activation of GHS 0.00)." })
  lines.push({ label: "Notices", value: "The shop owner gets an activation email and a push." })
  return { summary: "Activate a USSD shop code without payment", lines }
}

const waActivateCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const { lines, row } = await codeLines(ctx, asParams(i).id ?? "")
  if (row?.whatsapp_activated) lines.push({ label: "Result", value: "Already activated: the request is refused." })
  lines.push({ label: "What changes", value: "WhatsApp ordering is switched on for the shop with no wallet charge (recorded as a manual activation of GHS 0.00)." })
  lines.push({ label: "Notices", value: "The shop owner gets a push." })
  return { summary: "Grant WhatsApp shop activation for free", lines }
}

const waDeactivateCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const { lines, row } = await codeLines(ctx, asParams(i).id ?? "")
  if (row && !row.whatsapp_activated) lines.push({ label: "Result", value: "Not currently activated: the request is refused." })
  lines.push({ label: "What changes", value: "WhatsApp ordering is switched off for the shop. Any fee the owner paid is NOT refunded and stays on record." })
  lines.push({ label: "Notices", value: "Nobody is notified." })
  return { summary: "Revoke WhatsApp shop activation", lines }
}

const visibilityCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const r = await adminSetting(ctx, "ussd_service_visibility")
  const v = rowOf(r)?.value
  const cur = v && typeof v === "object" ? (v as Obj)[str(b.service)] : undefined
  const lines: CardLine[] = [
    { label: "USSD menu item", value: str(b.service) },
    { label: "Visible now", value: typeof cur === "boolean" ? onOff(cur) : "unknown (not saved yet, or could not be read)" },
    { label: "After this", value: onOff(b.visible === true) },
    { label: "What changes", value: b.visible === true ? "The item appears on the main USSD menu." : "The item is hidden from the main USSD menu for every caller. Nothing else is touched." },
    { label: "Who is affected", value: "Every USSD caller, from now on." },
  ]
  return { summary: `Turn the USSD menu item ${str(b.service)} ${onOff(b.visible === true)}`, lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// Hubtel USSD
// ---------------------------------------------------------------------------------------------------------------------

const VIS_KEYS = ["data", "afa", "airtime", "resultsChecker", "networkPlans", "payBills"] as const
const asciiLine = (max: number) => z.string().max(max).regex(/^[\x20-\x7E]*$/, "plain letters, numbers and basic punctuation only")

async function hubtelUssdConfigCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const main = b.line === "main"
  const key = main ? "hubtel_ussd_main_line_config" : "hubtel_ussd_config"
  const lines: CardLine[] = [{ label: "USSD line", value: main ? "Main code (*713*235*1#)" : "The original shop/main toggling code" }]
  const cur = rowOf(await adminSetting(ctx, key))?.value as Obj | undefined
  const old = (k: string) => (cur && cur[k] !== undefined ? cur[k] : undefined)
  if (b.enabled !== undefined) lines.push({ label: "Channel", value: change(typeof old("enabled") === "boolean" ? onOff(old("enabled") === true) : "(unknown)", onOff(b.enabled === true)) })
  if (b.enabled === true) lines.push({ label: "Needs", value: "Refused unless the Hubtel webhook secret, relay URL and relay secret are all set on the server." })
  if (b.mode !== undefined) lines.push({ label: "Mode", value: main ? "(refused: the main code has no mode)" : change(shown(old("mode")), str(b.mode)) })
  if (b.walletPayment !== undefined) lines.push({ label: "Pay from wallet", value: main ? change(typeof old("walletPayment") === "boolean" ? onOff(old("walletPayment") === true) : "(unknown)", onOff(b.walletPayment === true)) : "(refused: this is a main code setting: send line main)" })
  if (b.brandName !== undefined) lines.push({ label: "Brand name", value: change(shown(old("brandName")), str(b.brandName).trim() === "" ? "Clingshub (the default)" : str(b.brandName)) })
  if (b.welcome !== undefined) lines.push({ label: "Welcome line", value: change(shown(old("welcome")), str(b.welcome).trim() === "" ? "(reset to Welcome to <brand>)" : str(b.welcome)) })
  if (b.visibility && typeof b.visibility === "object") {
    const v = (cur?.visibility ?? {}) as Obj
    for (const [k, val] of Object.entries(b.visibility as Obj)) lines.push({ label: `Menu item ${k}`, value: change(typeof v[k] === "boolean" ? onOff(v[k] === true) : "(unknown)", onOff(val === true)) })
  }
  if (lines.length === 1) lines.push({ label: "Note", value: "Nothing to change: no setting was sent." })
  lines.push({ label: "Who is affected", value: "Every Hubtel USSD caller, from now on. The change is recorded in the admin audit log." })
  return { summary: "Change the Hubtel USSD settings", lines }
}

async function hubtelTxLines(ctx: CardCtx, sessionId: string): Promise<{ lines: CardLine[]; row: Obj | null }> {
  const r = await rowBy(ctx, "hubtel_transactions", "session_id, state, callback_status, amount_paid, order_table, order_id, paid_at, hubtel_order_id", "session_id", sessionId)
  const row = rowOf(r)
  const lines: CardLine[] = [{ label: "Hubtel USSD session", value: sessionId }, ...noteLine(r)]
  if (row) {
    lines.push({ label: "State now", value: `${shown(row.state)}, callback ${shown(row.callback_status)}` })
    lines.push({ label: "Paid", value: row.paid_at ? `${ghs(row.amount_paid)} at ${shown(row.paid_at)}` : "no payment recorded" })
    lines.push({ label: "Order", value: `${shown(row.order_table)} ${shown(row.order_id)}` })
    lines.push({ label: "Hubtel order id", value: shown(row.hubtel_order_id) })
  }
  return { lines, row }
}

const hubtelResolveCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const { lines, row } = await hubtelTxLines(ctx, str(b.sessionId))
  const ok = b.outcome === "fulfilled"
  lines.push({ label: "Outcome you record", value: ok ? "FULFILLED" : "NOT PAID" })
  lines.push({ label: "Note kept", value: str(b.note) })
  if (row && row.state !== "needs_review") lines.push({ label: "Result", value: `Only needs-review rows can be resolved (this one is ${shown(row.state)}): the request is refused.` })
  if (ok) lines.push({ label: "What changes", value: "The row is marked fulfilled. If it has a Hubtel order id and no callback yet, a success callback is queued for Hubtel (the customer is then treated as served)." })
  else {
    lines.push({ label: "What changes", value: "The row is marked failed AND the order behind it is marked failed so it cannot be paid later. Refused when a payment or a due callback is recorded." })
  }
  return { summary: ok ? "Mark a Hubtel USSD transaction fulfilled" : "Mark a Hubtel USSD transaction not paid", lines }
}

const hubtelRetryCbCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const { lines } = await hubtelTxLines(ctx, str(asBody(i).sessionId))
  lines.push({ label: "What changes", value: "The success callback is sent to Hubtel again now. A failed callback is re-armed first with a fresh window from now. Only fulfilled or needs-review rows are accepted; Hubtel may still reject a late callback." })
  return { summary: "Retry the Hubtel callback", lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// Text-to-Buy
// ---------------------------------------------------------------------------------------------------------------------

const TTB_FIELDS = Object.keys(TTB_SETTING_KEYS) as Array<keyof typeof TTB_SETTING_KEYS>
const TTB_CONFIRM: string[] = ["mainEnabled", "airtimeEnabled", "resultsCheckerEnabled", "shopEnabled", "callsEnabled"]
const ttbPhone = z.string().max(20)
const ttbSender = z.string().regex(/^[A-Za-z0-9 ]{0,11}$/)
const int = (min: number, max: number) => z.number().int().min(min).max(max)

async function ttbSettingsCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const lines: CardLine[] = []
  const sent = TTB_FIELDS.filter((f) => b[f] !== undefined)
  const old: Obj = {}
  let readOk = true
  for (const f of sent) {
    const r = await adminSetting(ctx, TTB_SETTING_KEYS[f])
    if (r.state === "unread") readOk = false
    old[f] = rowOf(r)?.value && typeof rowOf(r)!.value === "object" ? ((rowOf(r)!.value as Obj).value ?? undefined) : rowOf(r)?.value
  }
  for (const f of sent) {
    const was = readOk ? (old[f] === undefined ? "(default)" : shown(old[f])) : "(unknown)"
    const next = typeof b[f] === "boolean" ? onOff(b[f] === true) : shown(b[f])
    lines.push({ label: f, value: change(typeof old[f] === "boolean" ? onOff(old[f] === true) : was, next) })
  }
  if (sent.length === 0) lines.push({ label: "Note", value: "Nothing to change: no setting was sent." })
  if (!readOk) lines.push(UNREAD)
  const turnsOn = TTB_CONFIRM.filter((f) => b[f] === true)
  if (turnsOn.length > 0) {
    lines.push({ label: "Going live", value: `Switching on ${turnsOn.join(", ")} puts live customer texts (and for airtime or results checker, a money path) on the order path.` })
    if (b.confirm !== true) lines.push({ label: "Result", value: "Refused: switching these on needs confirm to be true." })
  }
  lines.push({ label: "Who is affected", value: "Every customer texting the Text-to-Buy numbers, from now on. Admins get one alert naming the settings changed (names only). Nothing is sent to customers." })
  return { summary: "Change the Text-to-Buy settings", lines }
}

const ttbActionCard = async (i: EntryInput): Promise<Card> => {
  const b = asBody(i)
  const lines: CardLine[] = [{ label: "Action", value: str(b.action) || "(missing)" }]
  if (b.action === "block" || b.action === "unblock") {
    lines.push({ label: "Customer number", value: b.sender ? str(b.sender) : "(missing: the request is refused)" })
    if (b.action === "block") {
      lines.push({ label: "Reason kept", value: b.reason ? str(b.reason) : "(none)" })
      lines.push({ label: "What changes", value: "Texts from this number are ignored by Text-to-Buy from now on. Nothing is sent to the customer." })
    } else lines.push({ label: "What changes", value: "The number is removed from the block list: its texts are read again." })
  } else if (b.action === "misread") {
    lines.push({ label: "Message", value: b.messageId ? str(b.messageId) : "(missing: the request is refused)" })
    lines.push({ label: "What changes", value: "The message is flagged as misread for review. Nothing is sent to the customer." })
  } else lines.push({ label: "Result", value: "Unknown action: the request is refused." })
  return { summary: `Text-to-Buy: ${str(b.action)}`, lines }
}

const ttbTryCard = async (i: EntryInput): Promise<Card> => {
  const b = asBody(i)
  return {
    summary: "Try a pretend text on Text-to-Buy",
    lines: [
      { label: "Line", value: str(b.line) },
      { label: "Pretend sender", value: str(b.sender) },
      { label: "Pretend text", value: str(b.text) },
      { label: "What happens", value: "A dry run: the real reader and rules show the reply that would go out. No order is placed, no SMS is sent, nothing is saved. It may use one AI call, and each admin gets 10 tries a minute." },
    ],
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------------------------------------------------

const PKG_COLS = "id, name, network, size, price, dealer_price, active, is_available, description, category"
const pkgName = (p: Obj): string => `${shown(p.name)} ${shown(p.network)} ${shown(p.size)}`.trim()

async function packageSaveCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const d = (b.packageData ?? {}) as Obj
  const updating = b.isUpdate === true && typeof b.packageId === "string" && b.packageId !== ""
  const lines: CardLine[] = []
  const fields = ["name", "network", "size", "price", "dealer_price", "active", "description", "category"]
  if (updating) {
    const r = await rowBy(ctx, "packages", PKG_COLS, "id", str(b.packageId))
    const row = rowOf(r)
    lines.push({ label: "Package", value: row ? `${pkgName(row)} (${short(str(b.packageId))})` : `id ${str(b.packageId)}` }, ...noteLine(r))
    for (const f of fields) {
      if (d[f] === undefined) continue
      const fmt = (v: unknown) => (f === "price" || f === "dealer_price" ? ghs(v) : shown(v))
      lines.push({ label: f, value: change(row ? fmt(row[f]) : "(unknown)", fmt(d[f])) })
    }
  } else {
    if (b.isUpdate === true) lines.push({ label: "Warning", value: "isUpdate was sent without a packageId, so this CREATES A NEW package instead of changing one." })
    lines.push({ label: "New package", value: pkgName(d) })
    for (const f of fields) if (d[f] !== undefined) lines.push({ label: f, value: f === "price" || f === "dealer_price" ? ghs(d[f]) : shown(d[f]) })
  }
  if (d.cost_price !== undefined) {
    let was = "(unknown)"
    if (updating) {
      const c = await rowBy(ctx, "package_costs", "cost_price", "package_id", str(b.packageId))
      was = rowOf(c) ? ghs(rowOf(c)!.cost_price) : c.state === "missing" ? "(none)" : "(unknown)"
    } else was = "(none)"
    lines.push({ label: "Supplier cost (admin only)", value: change(was, d.cost_price === null ? "removed" : ghs(d.cost_price)) })
  }
  lines.push({ label: "Who is affected", value: "Prices and the package list change for customers on every page, bot and the API at once, and the public price pages refresh. A package with a new price is not repriced on orders already placed." })
  return { summary: updating ? "Change a package" : "Add a new package", lines }
}

const packageDeleteCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const id = str(asBody(i).packageId)
  const r = await rowBy(ctx, "packages", PKG_COLS, "id", id)
  const row = rowOf(r)
  return {
    summary: "Delete a package",
    lines: [
      { label: "Package", value: row ? `${pkgName(row)} (${short(id)})` : `id ${id}` },
      ...noteLine(r),
      ...(row ? [{ label: "Price now", value: `${ghs(row.price)}, dealer ${ghs(row.dealer_price)}` }] : []),
      { label: "What changes", value: "The package is deleted for good, and it is also removed from every shop's package list (the shop copies are deleted with it). The public price pages refresh." },
    ],
  }
}

async function bulkPriceCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const ids = Array.isArray(b.packageIds) ? (b.packageIds as string[]) : []
  const updates = (b.updates ?? {}) as BulkPriceUpdates
  const how = (u?: { mode: string; value: number }) => (u ? (u.mode === "percentage" ? `${u.value >= 0 ? "+" : ""}${u.value}%` : `${ghs(u.value)} per GB`) : "")
  const lines: CardLine[] = []
  if (updates.price) lines.push({ label: "Price rule", value: how(updates.price) })
  if (updates.dealer_price) lines.push({ label: "Dealer price rule", value: how(updates.dealer_price) })
  let rows: Obj[] | null = null
  try {
    const { data, error } = await ctx.db.from("packages").select("id, name, network, size, price, dealer_price").in("id", ids)
    if (!error && Array.isArray(data)) rows = data as Obj[]
  } catch {
    rows = null
  }
  if (!rows) {
    lines.push(UNREAD, { label: "Packages", value: ids.join(", ") })
  } else {
    const found = new Set(rows.map((r) => str(r.id)))
    for (const r of rows) {
      const res = computePackagePriceUpdate({ id: str(r.id), price: Number(r.price), dealer_price: r.dealer_price === null || r.dealer_price === undefined ? null : Number(r.dealer_price), size: str(r.size) }, updates)
      const parts: string[] = []
      if (updates.price) parts.push(`price ${change(ghs(res.old_price), ghs(res.new_price))}`)
      if (updates.dealer_price) parts.push(`dealer ${change(ghs(res.old_dealer_price), ghs(res.new_dealer_price))}`)
      lines.push({ label: pkgName(r), value: res.skip_reason ? `SKIPPED (${res.skip_reason}): unchanged` : parts.join("; ") })
    }
    const missing = ids.filter((x) => !found.has(x))
    if (missing.length) lines.push({ label: "Not found (ignored)", value: missing.join(", ") })
  }
  lines.push({ label: "Who is affected", value: "Each package that passes the checks is repriced at once for every customer; skipped ones stay as they are. Orders already placed keep their price. The public price pages refresh." })
  return { summary: `Change the prices of ${ids.length} package(s)`, lines }
}

const toggleAvailCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const r = await rowBy(ctx, "packages", PKG_COLS, "id", str(b.packageId))
  const row = rowOf(r)
  return {
    summary: `${b.isAvailable === true ? "Enable" : "Disable"} a package`,
    lines: [
      { label: "Package", value: row ? `${pkgName(row)} (${short(str(b.packageId))})` : `id ${str(b.packageId)}` },
      ...noteLine(r),
      { label: "Available", value: change(row ? (row.is_available === false ? "OFF" : "ON") : "(unknown)", onOff(b.isAvailable === true)) },
      { label: "What changes", value: b.isAvailable === true ? "Customers can buy this package again." : "Customers can no longer buy this package; it is hidden from the price pages." },
    ],
  }
}

const networkStockCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const out = b.outOfStock === true
  const total = await readCount(() => ctx.db.from("packages").select("id", { count: "exact", head: true }).eq("network", str(b.network)))
  const r = await adminSetting(ctx, "network_stock_status")
  const cur = rowOf(r)?.value && typeof rowOf(r)!.value === "object" ? ((rowOf(r)!.value as Obj)[str(b.network)] as Obj | undefined) : undefined
  return {
    summary: `Mark ${str(b.network)} ${out ? "out of stock" : "back in stock"}`,
    lines: [
      { label: "Network", value: str(b.network) },
      { label: "Out of stock now", value: cur ? onOff(cur.outOfStock === true) : r.state === "unread" ? "unknown" : "OFF (nothing saved)" },
      { label: "After this", value: onOff(out) },
      { label: "Packages on this network", value: total === null ? "unknown" : String(total) },
      { label: "What changes", value: out ? "Every package on this network that is available now is switched off at once (the list is remembered so restocking turns the same ones back on). Customers cannot buy this network." : "The packages switched off by the last out-of-stock toggle are switched back on. Packages you disabled by hand stay off." },
      { label: "Who is affected", value: "Every customer, page, bot and the API, immediately; the public price pages refresh." },
    ],
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Hubtel order rows (standard bundles, utility bills, airtime) and Hubtel commission transactions
// ---------------------------------------------------------------------------------------------------------------------

const BUNDLE_COLS = "id, reference_code, network, bundle_display, beneficiary_phone, amount, paid_amount, status, payment_status, user_id"
const BILL_COLS = "id, reference_code, biller, account_number, phone, amount, paid_amount, status, payment_status, user_id"
const AIRTIME_COLS = "id, reference_code, network, beneficiary_phone, airtime_amount, total_paid, status, payment_status, user_id"

async function bundleLines(ctx: CardCtx, id: string): Promise<{ lines: CardLine[]; row: Obj | null }> {
  const r = await rowBy(ctx, "hubtel_data_orders", BUNDLE_COLS, "id", id)
  const row = rowOf(r)
  const lines: CardLine[] = [{ label: "Bundle order", value: row ? `${shown(row.reference_code)} (${short(id)})` : `id ${id}` }, ...noteLine(r)]
  if (row) {
    lines.push({ label: "Bundle", value: `${shown(row.network)} ${shown(row.bundle_display)}` })
    lines.push({ label: "Recipient number", value: shown(row.beneficiary_phone) })
    lines.push({ label: "Price / paid", value: `${ghs(row.amount)} / ${ghs(row.paid_amount)}` })
    lines.push({ label: "Status now", value: `${shown(row.status)}, payment ${shown(row.payment_status)}` })
  }
  return { lines, row }
}

async function billLines(ctx: CardCtx, id: string): Promise<{ lines: CardLine[]; row: Obj | null }> {
  const r = await rowBy(ctx, "hubtel_bill_orders", BILL_COLS, "id", id)
  const row = rowOf(r)
  const lines: CardLine[] = [{ label: "Bill order", value: row ? `${shown(row.reference_code)} (${short(id)})` : `id ${id}` }, ...noteLine(r)]
  if (row) {
    lines.push({ label: "Biller", value: shown(row.biller) })
    lines.push({ label: "Meter / account number", value: shown(row.account_number) })
    if (row.phone) lines.push({ label: "Phone on the bill", value: shown(row.phone) })
    lines.push({ label: "Amount / paid", value: `${ghs(row.amount)} / ${ghs(row.paid_amount)}` })
    lines.push({ label: "Status now", value: `${shown(row.status)}, payment ${shown(row.payment_status)}` })
  }
  return { lines, row }
}

async function airtimeLines(ctx: CardCtx, id: string): Promise<{ lines: CardLine[]; row: Obj | null }> {
  const r = await rowBy(ctx, "airtime_orders", AIRTIME_COLS, "id", id)
  const row = rowOf(r)
  const lines: CardLine[] = [{ label: "Airtime order", value: row ? `${shown(row.reference_code)} (${short(id)})` : `id ${id}` }, ...noteLine(r)]
  if (row) {
    lines.push({ label: "Network", value: shown(row.network) })
    lines.push({ label: "Recipient number", value: shown(row.beneficiary_phone) })
    lines.push({ label: "Airtime / customer paid", value: `${ghs(row.airtime_amount)} / ${ghs(row.total_paid)}` })
    lines.push({ label: "Status now", value: `${shown(row.status)}, payment ${shown(row.payment_status)}` })
  }
  return { lines, row }
}

const bundleSend = (summary: string, what: string) => async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const { lines } = await bundleLines(ctx, str(asBody(i).orderId))
  lines.push({ label: "What changes", value: what })
  return { summary, lines }
}

const billSend = (summary: string, what: string) => async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const { lines } = await billLines(ctx, str(asBody(i).orderId))
  lines.push({ label: "What changes", value: what })
  return { summary, lines }
}

const bundleRefundCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const { lines, row } = await bundleLines(ctx, str(b.orderId))
  lines.push({ label: "Refund", value: `${row ? ghs(row.paid_amount ?? row.amount) : "the amount paid"} is credited to the customer's wallet` })
  lines.push({ label: "Note kept", value: str(b.note) })
  lines.push({ label: "What changes", value: "Only a paid order that never reached Hubtel (no Hubtel transaction exists) is refunded: it is marked failed, the wallet is credited, then it is marked refunded. If a Hubtel transaction turns up, the refund aborts." })
  lines.push({ label: "Notices", value: "The customer gets an in-app notice and a push that the order was refunded." })
  return { summary: "Refund a standard bundle order to the wallet", lines }
}

const billRefundCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const { lines, row } = await billLines(ctx, str(b.orderId))
  lines.push({ label: "Refund", value: `${row ? ghs(row.paid_amount ?? row.amount) : "the amount paid"} goes back to the customer` })
  lines.push({ label: "Note kept", value: str(b.note) })
  lines.push({ label: "Override", value: b.force === true ? "FORCE: also refunds a row an admin had marked failed by hand, even though Hubtel did not fail it." : "No force: a row marked failed by an admin override is refused." })
  lines.push({ label: "What changes", value: "A paid order that never reached Hubtel is marked failed and refunded to the wallet; an order Hubtel failed is refunded through its ledger row. If a Hubtel transaction turns up, the refund aborts. Admins may be alerted." })
  return { summary: "Refund a utility bill order", lines }
}

const airtimeAction = (action: unknown): string =>
  action === "completed"
    ? "The order is marked completed and the customer is told by in-app notice, SMS and email that the airtime was delivered. If the order was flagged and has a shop commission, that commission is paid to the shop now. Nothing is sent to the network: only mark it completed if the airtime really arrived."
    : "The order is marked failed. A customer who paid from a wallet is refunded their full payment (wallet credit, ledger entry, notice, SMS and email); a guest storefront order gets no automatic refund (refund it on the refunds page). The shop's commission on the order is reversed and the shop balance recalculated."

const airtimeActionCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const { lines, row } = await airtimeLines(ctx, str(b.orderId))
  lines.push({ label: "Mark as", value: str(b.action).toUpperCase() })
  if (b.notes) lines.push({ label: "Note kept", value: str(b.notes) })
  if (row && !["pending", "processing", "flagged"].includes(str(row.status))) lines.push({ label: "Result", value: "Only pending, processing or flagged orders can be changed: the request is refused." })
  lines.push({ label: "What changes", value: airtimeAction(b.action) })
  return { summary: `Mark an airtime order ${str(b.action)}`, lines }
}

const airtimeBulkCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const ids = Array.isArray(b.orderIds) ? (b.orderIds as string[]) : []
  const lines: CardLine[] = [{ label: "Mark as", value: str(b.status).toUpperCase() }, { label: "Orders", value: String(ids.length) }]
  try {
    const { data, error } = await ctx.db.from("airtime_orders").select("id, reference_code, network, beneficiary_phone, airtime_amount, total_paid, status").in("id", ids)
    if (error || !Array.isArray(data)) throw new Error("read")
    for (const r of data as Obj[]) lines.push({ label: shown(r.reference_code), value: `${shown(r.network)} ${ghs(r.airtime_amount)} to ${shown(r.beneficiary_phone)}, paid ${ghs(r.total_paid)}, now ${shown(r.status)}` })
  } catch {
    lines.push(UNREAD, { label: "Order ids", value: ids.join(", ") })
  }
  if (b.notes) lines.push({ label: "Note kept", value: str(b.notes) })
  lines.push({ label: "What changes", value: `For every pending, processing or flagged order in the list (others are skipped): ${airtimeAction(b.status)}` })
  return { summary: `Mark ${ids.length} airtime order(s) ${str(b.status)}`, lines }
}

const airtimeAutoCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const ids = Array.isArray(b.orderIds) ? (b.orderIds as string[]) : typeof b.orderId === "string" ? [b.orderId] : []
  const lines: CardLine[] = [{ label: "Orders", value: String(ids.length) }]
  try {
    const { data, error } = await ctx.db.from("airtime_orders").select("id, reference_code, network, beneficiary_phone, airtime_amount, status").in("id", ids)
    if (error || !Array.isArray(data)) throw new Error("read")
    for (const r of data as Obj[]) lines.push({ label: shown(r.reference_code), value: `${shown(r.network)} ${ghs(r.airtime_amount)} to ${shown(r.beneficiary_phone)}, now ${shown(r.status)}` })
  } catch {
    lines.push(UNREAD, { label: "Order ids", value: ids.join(", ") })
  }
  lines.push({ label: "What changes", value: "Each PENDING order is sent to the Digiwapy airtime supplier now, buying real airtime from the Digiwapy balance and marking the order processing. Orders Hubtel already took (any live Hubtel transaction) are skipped, and nothing is sent when the Hubtel ledger cannot be read." })
  return { summary: `Send ${ids.length} airtime order(s) to Digiwapy`, lines }
}

const airtimeHubtelCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const { lines } = await airtimeLines(ctx, str(asBody(i).orderId))
  lines.push({ label: "What changes", value: "A paid order stuck in pending (never sent, or failed at Hubtel) is sent to Hubtel now as a NEW purchase for the full airtime amount to the number shown, paid from the Hubtel float. Refused if a live Hubtel transaction exists; admins may be alerted." })
  return { summary: "Send an airtime order via Hubtel", lines }
}

const airtimeSyncCard = async (): Promise<Card> => ({
  summary: "Check Digiwapy for every processing airtime order",
  lines: [{ label: "What changes", value: "Every airtime order that is processing through Digiwapy is looked up at Digiwapy. One that Digiwapy says is completed is marked completed; one Digiwapy says failed goes back to pending so it can be retried. Nothing is bought and no wallet is touched." }],
})

const AIRTIME_NETS = ["mtn", "telecel", "at"] as const

async function airtimeSettingsCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const s = (asBody(i).settings ?? {}) as Obj
  const lines: CardLine[] = []
  const keys = Object.keys(s)
  for (const k of keys) {
    const r = await adminSetting(ctx, k)
    const was = rowOf(r)?.value
    const fmt = (v: unknown) => (v && typeof v === "object" ? Object.entries(v as Obj).map(([a, b]) => `${a} ${typeof b === "boolean" ? onOff(b) : shown(b)}`).join(", ") : shown(v))
    lines.push({ label: k, value: change(r.state === "unread" ? "(unknown)" : r.state === "missing" ? "(not set)" : fmt(was), fmt(s[k])) })
  }
  if (keys.length === 0) lines.push({ label: "Note", value: "Nothing to change: no setting was sent." })
  if (keys.some((k) => k.startsWith("airtime_fee_"))) lines.push({ label: "Prices", value: "A fee rate changes what customers, dealers or sub-agents are charged on airtime orders placed from now on." })
  if (keys.some((k) => k.startsWith("airtime_provider_"))) lines.push({ label: "Provider", value: "Decides where new orders on that network are sent (Digiwapy, Hubtel, Hubnet or manual); there is no automatic fallback between providers." })
  lines.push({ label: "Who is affected", value: "Every airtime customer, from now on. Nothing is sent to customers." })
  return { summary: "Change the airtime settings", lines }
}

async function hubtelTxCardLines(ctx: CardCtx, ref: string): Promise<{ lines: CardLine[]; row: Obj | null }> {
  const r = await rowBy(ctx, "hubtel_cs_transactions", "client_reference, service_key, destination, amount, state, order_table, order_id, resolved_by, resolution_note, refund_claimed_at", "client_reference", ref)
  const row = rowOf(r)
  const lines: CardLine[] = [{ label: "Hubtel reference", value: ref }, ...noteLine(r)]
  if (row) {
    lines.push({ label: "Service", value: shown(row.service_key) })
    lines.push({ label: "Recipient (number / meter / account)", value: shown(row.destination) })
    lines.push({ label: "Amount", value: ghs(row.amount) })
    lines.push({ label: "State now", value: shown(row.state) })
    if (row.resolved_by) lines.push({ label: "Marked by an admin", value: `${shown(row.resolution_note)}` })
  }
  return { lines, row }
}

const csCheckCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const { lines } = await hubtelTxCardLines(ctx, str(asBody(i).ref))
  lines.push({ label: "What changes", value: "Hubtel is asked for the live status. The row may move to fulfilled, failed or needs-review as a result, and an order behind it may be settled or refunded by the usual hooks. Nothing is bought." })
  return { summary: "Check a Hubtel transaction's status", lines }
}

const csRefundCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const { lines, row } = await hubtelTxCardLines(ctx, str(b.ref))
  lines.push({ label: "Refund", value: `${row ? ghs(row.amount) : "the amount paid"} is credited back to the customer's wallet` })
  lines.push({ label: "Override", value: b.force === true ? "FORCE: also refunds a row an admin marked failed by hand." : "No force: a row an admin marked failed by hand is refused." })
  lines.push({ label: "What changes", value: "Only a failed row with no newer attempt is refunded; the refund is claimed first so it cannot be paid twice." })
  return { summary: "Refund a failed Hubtel transaction to the wallet", lines }
}

const csResolveCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const { lines } = await hubtelTxCardLines(ctx, str(b.ref))
  lines.push({ label: "Outcome you record", value: str(b.outcome).toUpperCase() })
  lines.push({ label: "Note kept", value: str(b.note) })
  lines.push({ label: "What changes", value: b.outcome === "fulfilled" ? "The row is marked fulfilled by hand and the order behind it is settled as delivered. Refused if a refund was already claimed." : "The row is marked failed by hand: the order behind it is settled as failed and, where it applies, becomes refundable (use refund with force)." })
  return { summary: `Mark a Hubtel transaction ${str(b.outcome)} by hand`, lines }
}

const csRetryCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const { lines } = await hubtelTxCardLines(ctx, str(asBody(i).ref))
  lines.push({ label: "What changes", value: "The order behind this failed transaction is sent to Hubtel AGAIN as a new purchase for the same recipient and amount, paid from the Hubtel float. Refused if a newer or live attempt exists or the ledger cannot be read." })
  return { summary: "Retry a failed Hubtel transaction", lines }
}

const csTestCard = async (i: EntryInput): Promise<Card> => {
  const b = asBody(i)
  return {
    summary: `LIVE test purchase of ${ghs(b.amount)} on Hubtel`,
    lines: [
      { label: "Service", value: str(b.serviceKey) },
      { label: "Recipient (number / meter / account)", value: shown(b.destination) },
      { label: "Amount", value: ghs(b.amount) },
      ...(b.bundle ? [{ label: "Bundle", value: str(b.bundle) }] : []),
      { label: "What happens", value: "A REAL purchase is sent to Hubtel and paid from the Hubtel float. It is capped at GHS 5.00 and refused unless Hubtel Commission Services is switched on. Nothing is credited back to anyone." },
    ],
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Config switches: standard bundles, utility bills, Hubtel commission
// ---------------------------------------------------------------------------------------------------------------------

async function bundlesConfigCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const cur = rowOf(await adminSetting(ctx, "standard_bundles_config"))?.value as Obj | undefined
  const lines: CardLine[] = []
  if (b.enabled !== undefined) lines.push({ label: "Standard bundles", value: change(cur && typeof cur.enabled === "boolean" ? onOff(cur.enabled) : "(unknown)", onOff(b.enabled === true)) })
  for (const [n, v] of Object.entries((b.networks ?? {}) as Obj)) {
    const o = ((cur?.networks as Obj | undefined)?.[n] ?? {}) as Obj
    const x = v as Obj
    lines.push({ label: `${n}`, value: `${change(o.enabled === undefined ? "(unknown)" : onOff(o.enabled === true), onOff(x.enabled === true))}; hidden categories ${(x.hiddenCategories as string[]).join(", ") || "none"}; reference number ${str(x.referenceNumber)}` })
  }
  if (b.special && typeof b.special === "object") {
    const x = b.special as Obj
    const o = (cur?.special ?? {}) as Obj
    lines.push({ label: "Special Bundles", value: `${change(o.enabled === undefined ? "(unknown)" : onOff(o.enabled === true), onOff(x.enabled === true))}; unit price ${change(o.unitAmount === undefined ? "(unknown)" : ghs(o.unitAmount), ghs(x.unitAmount))}; multiples ${(x.multiples as number[]).join(", ")}; Hubtel unit value ${str(x.unitValue)}; sold on USSD ${onOff(x.ussdEnabled === true)}` })
  }
  if (lines.length === 0) lines.push({ label: "Note", value: "Nothing to change: no setting was sent." })
  lines.push({ label: "Who is affected", value: "Every customer buying standard data bundles through Hubtel, from now on. Existing orders are not touched." })
  return { summary: "Change the standard bundles settings", lines }
}

async function billsConfigCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const cur = rowOf(await adminSetting(ctx, "utility_bills_config"))?.value as Obj | undefined
  const lines: CardLine[] = []
  if (b.enabled !== undefined) lines.push({ label: "Utility bills", value: change(cur && typeof cur.enabled === "boolean" ? onOff(cur.enabled) : "(unknown)", onOff(b.enabled === true)) })
  if (b.autoFulfil !== undefined) lines.push({ label: "Pay bills automatically after payment", value: change(cur ? onOff(cur.autoFulfil !== false) : "(unknown)", onOff(b.autoFulfil === true)) })
  for (const [k, v] of Object.entries((b.billers ?? {}) as Obj)) {
    const o = ((cur?.billers as Obj | undefined)?.[k] ?? {}) as Obj
    const x = v as Obj
    lines.push({ label: k, value: `${change(o.enabled === undefined ? "(unknown)" : onOff(o.enabled === true), onOff(x.enabled === true))}; limits ${change(o.min === undefined ? "(unknown)" : `${ghs(o.min)} to ${ghs(o.max)}`, `${ghs(x.min)} to ${ghs(x.max)}`)}` })
  }
  if (lines.length === 0) lines.push({ label: "Note", value: "Nothing to change: no setting was sent." })
  lines.push({ label: "Who is affected", value: "Every customer paying utility bills, from now on. With automatic payment ON, paid bills are sent to Hubtel straight away." })
  return { summary: "Change the utility bills settings", lines }
}

async function csConfigCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const cur = rowOf(await adminSetting(ctx, "hubtel_cs_config"))?.value as Obj | undefined
  const lines: CardLine[] = []
  if (b.enabled !== undefined) lines.push({ label: "Hubtel Commission Services", value: change(cur && typeof cur.enabled === "boolean" ? onOff(cur.enabled) : "(unknown)", onOff(b.enabled === true)) })
  if (b.mode !== undefined) lines.push({ label: "How requests reach Hubtel", value: change(shown(cur?.mode), str(b.mode)) })
  if (b.lowBalanceThreshold !== undefined) lines.push({ label: "Low float alert", value: change(cur?.lowBalanceThreshold === undefined ? "(unknown)" : cur.lowBalanceThreshold === null ? "none" : ghs(cur.lowBalanceThreshold), b.lowBalanceThreshold === null ? "none" : ghs(b.lowBalanceThreshold)) })
  for (const [k, v] of Object.entries((b.services ?? {}) as Obj)) lines.push({ label: `Service ${k}`, value: change(cur?.services && typeof (cur.services as Obj)[k] === "boolean" ? onOff((cur.services as Obj)[k] === true) : "(unknown)", onOff(v === true)) })
  if (b.paused === false) lines.push({ label: "Pause", value: "The automatic pause is cleared: purchases are allowed again." })
  if (lines.length === 0) lines.push({ label: "Note", value: "Nothing to change: no setting was sent." })
  if (b.enabled === true) lines.push({ label: "Needs", value: "Refused unless the Hubtel callback secret, app URL, relay and (for direct mode) credentials are all set on the server." })
  lines.push({ label: "Who is affected", value: "Every purchase that goes through Hubtel (airtime, bundles, bills), from now on." })
  return { summary: "Change the Hubtel Commission settings", lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// Results checker
// ---------------------------------------------------------------------------------------------------------------------

const RC_COLS = "id, reference_code, exam_board, status, payment_status, total_paid, user_id"

const rcActionCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const r = await rowBy(ctx, "results_checker_orders", RC_COLS, "id", str(b.orderId))
  const row = rowOf(r)
  const lines: CardLine[] = [{ label: "Voucher order", value: row ? `${shown(row.reference_code)} (${short(str(b.orderId))}), ${shown(row.exam_board)}` : `id ${str(b.orderId)}` }, ...noteLine(r)]
  if (row) lines.push({ label: "Now", value: `${shown(row.status)}, payment ${shown(row.payment_status)}, paid ${ghs(row.total_paid)}, ${row.user_id ? "signed-in customer" : "guest customer"}` })
  if (b.action === "deliver") {
    lines.push({ label: "Action", value: "DELIVER the vouchers" })
    lines.push({ label: "What changes", value: "Vouchers are taken from current stock, assigned to this paid order and the PINs are sent to the customer. Refused for an unpaid or completed order, or when stock is short. The PINs are not shown here or to the assistant." })
  } else {
    lines.push({ label: "Action", value: b.action === "refund" ? "REFUND (cancel the order)" : "Mark FAILED (cancel the order)" })
    if (b.notes) lines.push({ label: "Note kept", value: str(b.notes) })
    const refundsWallet = row ? Boolean(row.user_id) && row.payment_status === "completed" : null
    lines.push({ label: "Money", value: refundsWallet === null ? "A paid signed-in customer is refunded to their wallet; a guest or unpaid order is NOT refunded." : refundsWallet ? `${ghs(row!.total_paid)} is refunded to the customer's wallet.` : "No refund is made: this is a guest or unpaid order, it is only cancelled." })
    lines.push({ label: "What changes", value: "Reserved vouchers are released and the order is marked failed (both 'refund' and 'failed' do the same). A wallet-paid order the system never marked paid is refused and must be refunded by hand." })
    lines.push({ label: "Notices", value: "A signed-in customer gets an in-app notice that the order was cancelled and refunded." })
  }
  return { summary: `Results checker order: ${str(b.action)}`, lines }
}

const rcInventoryCard = async (i: EntryInput): Promise<Card> => {
  const ids = (asBody(i).ids ?? []) as string[]
  return {
    summary: `Mark ${ids.length} voucher(s) invalid`,
    lines: [
      { label: "Vouchers", value: ids.join(", ") },
      { label: "What changes", value: "The listed vouchers are marked invalid and will never be sold or delivered. The voucher PINs are not shown." },
    ],
  }
}

async function rcSettingsCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const s = (asBody(i).settings ?? {}) as Obj
  const lines: CardLine[] = []
  const fmt = (v: unknown) => (v && typeof v === "object" ? Object.entries(v as Obj).map(([a, b]) => `${a} ${typeof b === "boolean" ? onOff(b) : shown(b)}`).join(", ") : shown(v))
  for (const k of Object.keys(s)) {
    const r = await adminSetting(ctx, k)
    lines.push({ label: k, value: change(r.state === "unread" ? "(unknown)" : r.state === "missing" ? "(not set)" : fmt(rowOf(r)?.value), fmt(s[k])) })
  }
  if (lines.length === 0) lines.push({ label: "Note", value: "Nothing to change: no setting was sent." })
  lines.push({ label: "Who is affected", value: "Prices, bulk prices, markups, limits and switches apply to every voucher order placed from now on; orders already placed keep their price." })
  return { summary: "Change the results checker settings", lines }
}

const rcRequestsCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const r = await rowBy(ctx, "results_check_requests", "id, exam_board, index_number, status, channel, payment_status", "id", str(b.id))
  const row = rowOf(r)
  const lines: CardLine[] = [{ label: "Results check request", value: row ? `${short(str(b.id))}, ${shown(row.exam_board)}, index number ${shown(row.index_number)}` : `id ${str(b.id)}` }, ...noteLine(r)]
  if (row) lines.push({ label: "Status now", value: shown(row.status) })
  if (b.status !== undefined) lines.push({ label: "Status", value: change(row ? shown(row.status) : "(unknown)", str(b.status)) })
  if (b.result_data !== undefined) lines.push({ label: "Result text saved", value: str(b.result_data) === "" ? "(cleared)" : str(b.result_data) })
  if (b.media_url !== undefined) lines.push({ label: "Result file saved", value: `${str(b.media_url)} (${str(b.media_type) || "type unchanged"})` })
  if (b.deliver === true) lines.push({ label: "Delivery", value: "The saved result is SENT to the customer now (on the channel they used). It only happens when the request has result text or a file after this change." })
  if (b.status === "completed") lines.push({ label: "Notices", value: "The customer is told their results are ready (unless delivery fails)." })
  else if (b.status && ["failed", "declined", "rejected", "cancelled"].includes(str(b.status))) lines.push({ label: "Notices", value: `The customer is told the request was rejected${b.reason ? `, with the reason: ${str(b.reason)}` : ""}.` })
  else lines.push({ label: "Notices", value: "Only a real status change notifies the customer." })
  return { summary: "Update a results check request", lines }
}

const rcPhonesCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const phones = (asBody(i).phones ?? []) as string[]
  const r = await adminSetting(ctx, "results_check_admin_phones")
  const old = rowOf(r)?.value && typeof rowOf(r)!.value === "object" ? ((rowOf(r)!.value as Obj).phones as string[] | undefined) : undefined
  return {
    summary: "Set the admin WhatsApp numbers for results checks",
    lines: [
      { label: "Numbers now", value: Array.isArray(old) ? old.join(", ") || "none" : r.state === "unread" ? "unknown" : "none" },
      { label: "Numbers after this", value: phones.join(", ") || "none" },
      { label: "What changes", value: "These numbers get WhatsApp alerts for new results check requests and can claim and deliver by WhatsApp. Numbers are saved in local 0XXXXXXXXX form with duplicates removed. Nothing is sent now." },
    ],
  }
}

const rcCheckSettingsCard = async (i: EntryInput, ctx: CardCtx): Promise<Card> => {
  const b = asBody(i)
  const cur = rowOf(await adminSetting(ctx, "results_check_settings"))?.value as Obj | undefined
  const lines: CardLine[] = []
  if (b.enabled !== undefined) lines.push({ label: "Results check service", value: change(cur ? onOff(cur.enabled !== false) : "(unknown)", onOff(b.enabled === true)) })
  if (b.fee !== undefined) lines.push({ label: "Fee per request", value: change(cur && typeof cur.fee === "number" ? ghs(cur.fee) : cur ? "GHS 2.00 (default)" : "(unknown)", ghs(b.fee)) })
  if (lines.length === 0) lines.push({ label: "Note", value: "Nothing to change: no setting was sent." })
  lines.push({ label: "Who is affected", value: "Every customer requesting a results check, from now on." })
  return { summary: "Change the results check service settings", lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------------------------------

const page = z.number().int().min(1).max(1000)
const limit100 = z.number().int().min(1).max(100)
const dateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const orderIdBody = z.object({ orderId: uuid }).strict()
const note500 = z.string().min(1).max(500)
const refText = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)
const priceField = z.object({ mode: z.enum(["percentage", "per_gb"]), value: z.number().finite().min(-100).max(100000) }).strict()
const ghMobile233 = z.string().regex(/^233\d{9}$/)
const billerKey = z.enum(BILLER_KEYS as unknown as [string, ...string[]])
const serviceKey = z.enum(HUBTEL_CS_SERVICE_KEYS as unknown as [string, ...string[]])

const packageData = z
  .object({
    name: z.string().min(1).max(200).optional(),
    network: z.enum(["MTN", "AirtelTigo", "Telecel"]).optional(),
    size: z.string().min(1).max(40).optional(),
    price: ghsNum.optional(),
    dealer_price: z.number().finite().min(0).max(1_000_000).optional(),
    active: bool.optional(),
    description: z.string().max(500).optional(),
    category: z.string().max(60).optional(),
    cost_price: z.number().finite().min(0).max(99999999.99).nullable().optional(),
  })
  .strict()

const ttbShape: Record<string, z.ZodTypeAny> = {
  mainEnabled: bool, mainNumber: ttbPhone, replySenderId: ttbSender, shopReplySenderId: ttbSender, aiEnabled: bool,
  staleMinutes: int(1, 120), promptsPerHour: int(1, 20), repliesPerHour: int(1, 30), aiReadsPerHour: int(0, 60),
  globalPromptsPerMinute: int(1, 500), promptWindowMinutes: int(2, 30), quietAlertMinutes: int(10, 1440), retentionDays: int(1, 90),
  unclearRepliesEnabled: bool, globalRepliesPerHour: int(10, 5000), airtimeEnabled: bool, resultsCheckerEnabled: bool,
  shopEnabled: bool, shopNumber: ttbPhone, shopRepliesPerHourPerShop: int(5, 1000), callsEnabled: bool, callsPerHourPerLine: int(5, 500),
  replyTransportMain: z.enum(["hubtel", "sim"]), replyTransportShop: z.enum(["hubtel", "sim"]), simSlotMain: int(1, 2),
  simSlotShop: int(1, 2), simMaxPer30Min: int(1, 30),
}
const ttbBody = z.object({ ...Object.fromEntries(Object.entries(ttbShape).map(([k, v]) => [k, v.optional()])), confirm: bool.optional() }).strict()

const netSetting = z.object({ enabled: bool, hiddenCategories: z.array(z.string().min(1).max(40)).max(20), referenceNumber: ghMobile233 }).strict()
const billerSetting = z.object({ enabled: bool, min: z.number().finite().min(1).max(10000), max: z.number().finite().min(1).max(10000) }).strict()

const airtimeValue = (field: string, schema: z.ZodTypeAny) => z.object({ [field]: schema }).strict()
const airtimeSettingsShape: Record<string, z.ZodTypeAny> = {
  airtime_min_amount: airtimeValue("amount", z.number().finite().min(0).max(100000)),
  airtime_max_amount: airtimeValue("amount", z.number().finite().min(0).max(100000)),
}
for (const n of AIRTIME_NETS) {
  for (const who of ["customer", "dealer", "sub_agent"]) airtimeSettingsShape[`airtime_fee_${n}_${who}`] = airtimeValue("rate", z.number().finite().min(0).max(100))
  airtimeSettingsShape[`airtime_enabled_${n}`] = airtimeValue("enabled", bool)
  airtimeSettingsShape[`airtime_digiwapy_enabled_${n}`] = airtimeValue("enabled", bool)
  airtimeSettingsShape[`airtime_provider_${n}`] = airtimeValue("provider", z.enum(AIRTIME_PROVIDERS as unknown as [string, ...string[]]))
}

const rcSettingsShape: Record<string, z.ZodTypeAny> = {
  results_checker_max_quantity: airtimeValue("max", int(1, 1000)),
  results_checker_reservation_timeout: airtimeValue("minutes", int(1, 240)),
  results_checker_bulk_min_quantity: airtimeValue("min", int(1, 1000)),
}
for (const bk of ["wassce", "bece", "novdec"]) {
  rcSettingsShape[`results_checker_price_${bk}`] = airtimeValue("price", z.number().finite().min(0).max(100000))
  rcSettingsShape[`results_checker_enabled_${bk}`] = airtimeValue("enabled", bool)
  rcSettingsShape[`results_checker_max_markup_${bk}`] = airtimeValue("max", z.number().finite().min(0).max(100000))
  rcSettingsShape[`results_checker_bulk_price_${bk}`] = airtimeValue("price", z.number().finite().min(0).max(100000))
}
const optionalShape = (s: Record<string, z.ZodTypeAny>) => z.object(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.optional()]))).strict()

// ---------------------------------------------------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------------------------------------------------

const SHOPS = "/admin/shops"
const USSD_SHOPS = "/admin/ussd-shops"
const HUBTEL_USSD = "/admin/ussd-hubtel"
const TTB = "/admin/text-to-buy"
const PACKAGES = "/admin/packages"
const COMMISSION = "/admin/hubtel-commission"
const BILLS = "/admin/utility-bills"
const AIRTIME = "/admin/airtime"
const RC = "/admin/results-checker"
const RCR = "/admin/results-check-requests"

export const SERVICES_ENTRIES: CatalogEntry[] = [
  // ---- shops
  mk({
    id: "shops.list", page: SHOPS, summary: "List shops with their status and owner name, filtered by status or name.",
    method: "GET", path: "/api/admin/shops",
    query: z.object({ status: z.string().max(40).optional(), search: z.string().max(100).optional(), limit: limit100.optional() }).strict(),
    kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["success", "count", "data[].id", "data[].shop_name", "data[].shop_slug", "data[].is_active", "data[].is_blocked", "data[].block_reason", "data[].created_at", "data[].owner_name"],
  }),
  mk({
    id: "shops.detail", page: SHOPS, summary: "Show one shop with its recent orders, recent profits and available balance.",
    method: "GET", path: "/api/admin/shops/:shopId", params: { shopId: "uuid" },
    kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: [
      "data.shop.id", "data.shop.shop_name", "data.shop.shop_slug", "data.shop.is_active", "data.shop.is_blocked", "data.shop.block_reason", "data.shop.blocked_at", "data.available_balance",
      "data.orders[].id", "data.orders[].reference_code", "data.orders[].network", "data.orders[].volume_gb", "data.orders[].total_price", "data.orders[].profit_amount", "data.orders[].order_status", "data.orders[].payment_status", "data.orders[].created_at",
      "data.profits[].id", "data.profits[].profit_amount", "data.profits[].status", "data.profits[].adjustment_type", "data.profits[].created_at",
    ],
  }),
  mk({
    id: "shops.balance_adjust", page: SHOPS, summary: "Credit or debit a shop's profit balance by hand.",
    method: "POST", path: "/api/admin/shops/:shopId/balance-adjustment", params: { shopId: "uuid" },
    body: z.object({ amount: ghsNum, type: z.enum(["credit", "debit"]), notes: z.string().max(200).optional() }).strict(),
    kind: "change", risk: "money", auth: "admin", card: shopBalanceCard,
  }),
  mk({
    id: "shops.approve", page: SHOPS, summary: "Approve a shop so it becomes active, and tell the owner.",
    method: "POST", path: "/api/admin/shops/approve", body: z.object({ shopId: uuid }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: shopApproveCard,
  }),
  mk({
    id: "shops.reject", page: SHOPS, summary: "Reject a shop (set it to not active), and tell the owner.",
    method: "POST", path: "/api/admin/shops/reject", body: z.object({ shopId: uuid, reason: z.string().max(200).optional() }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: shopRejectCard,
  }),
  mk({
    id: "shops.block", page: SHOPS, summary: "Block or unblock a shop, and tell the owner by notice, push and SMS.",
    method: "POST", path: "/api/admin/shops/block",
    body: z.object({ shopId: uuid, action: z.enum(["block", "unblock"]), reason: z.string().max(300).optional() }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: shopBlockCard,
  }),

  // ---- ussd shops (own bearer-token admin check: users.role = 'admin')
  mk({
    id: "ussd_shops.list", page: USSD_SHOPS, summary: "List every USSD shop code with its status, activation and order count, plus activation revenue.",
    method: "GET", path: "/api/admin/ussd-shops", kind: "lookup", risk: "normal", auth: "other",
    resultKeep: ["data[].id", "data[].code", "data[].status", "data[].activation_fee_paid", "data[].whatsapp_activated", "data[].shop_id", "data[].shop_name", "data[].order_count", "data[].created_at", "activationRevenue", "todayActivationRevenue"],
  }),
  mk({
    id: "ussd_shops.detail", page: USSD_SHOPS, summary: "Show one USSD shop code.",
    method: "GET", path: "/api/admin/ussd-shops/:id", params: { id: "uuid" }, kind: "lookup", risk: "normal", auth: "other",
    resultKeep: ["data.id", "data.code", "data.status", "data.activation_fee_paid", "data.activation_paid_at", "data.created_at", "data.user_shops.shop_name"],
  }),
  mk({
    id: "ussd_shops.create", page: USSD_SHOPS, summary: "Create a USSD shop code for a shop (a chosen code or an automatic one).",
    method: "POST", path: "/api/admin/ussd-shops",
    body: z.object({ shop_id: uuid, code: z.string().min(1).max(20).regex(/^[A-Za-z0-9]+$/).optional() }).strict(),
    kind: "change", risk: "danger", auth: "other", card: ussdShopCreateCard,
  }),
  mk({
    id: "ussd_shops.update", page: USSD_SHOPS, summary: "Change a USSD shop code's status (active, inactive, suspended) or the code itself.",
    method: "PUT", path: "/api/admin/ussd-shops/:id", params: { id: "uuid" },
    body: z.object({ status: z.enum(["active", "inactive", "suspended"]).optional(), code: z.string().min(1).max(20).regex(/^[A-Za-z0-9]+$/).optional() }).strict(),
    kind: "change", risk: "danger", auth: "other", card: ussdShopUpdateCard,
  }),
  mk({
    id: "ussd_shops.delete", page: USSD_SHOPS, summary: "Delete a USSD shop code that has no pending orders.",
    method: "DELETE", path: "/api/admin/ussd-shops/:id", params: { id: "uuid" },
    kind: "change", risk: "danger", auth: "other", card: ussdShopDeleteCard,
  }),
  mk({
    id: "ussd_shops.activate", page: USSD_SHOPS, summary: "Activate a USSD shop code and mark its activation fee paid without a payment.",
    method: "POST", path: "/api/admin/ussd-shops/:id/activate", params: { id: "uuid" },
    kind: "change", risk: "money", auth: "other", card: ussdActivateCard,
  }),
  mk({
    id: "ussd_shops.whatsapp_activate", page: USSD_SHOPS, summary: "Give a shop WhatsApp ordering for free (no wallet charge).",
    method: "POST", path: "/api/admin/ussd-shops/:id/whatsapp-activate", params: { id: "uuid" },
    kind: "change", risk: "money", auth: "other", card: waActivateCard,
  }),
  mk({
    id: "ussd_shops.whatsapp_deactivate", page: USSD_SHOPS, summary: "Switch off a shop's WhatsApp ordering (no refund).",
    method: "POST", path: "/api/admin/ussd-shops/:id/whatsapp-deactivate", params: { id: "uuid" },
    kind: "change", risk: "money", auth: "other", card: waDeactivateCard,
  }),

  // ---- ussd service visibility
  mk({
    id: "ussd.visibility.read", page: HUBTEL_USSD, summary: "Show which items are visible on the main USSD menu.",
    method: "GET", path: "/api/admin/ussd/service-visibility", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: USSD_VISIBILITY_SERVICES.map((s) => `status.${s}`),
  }),
  mk({
    id: "ussd.visibility.set", page: HUBTEL_USSD, summary: "Show or hide one item on the main USSD menu for every caller.",
    method: "POST", path: "/api/admin/ussd/service-visibility",
    body: z.object({ service: z.enum(USSD_VISIBILITY_SERVICES as unknown as [string, ...string[]]), visible: bool }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: visibilityCard,
  }),

  // ---- hubtel ussd
  mk({
    id: "ussd_hubtel.callback_logs", page: HUBTEL_USSD, summary: "List Hubtel USSD callback log entries (summary columns only), newest first.",
    method: "GET", path: "/api/admin/ussd-hubtel/callback-logs",
    query: z.object({ direction: z.enum(["inbound_fulfillment", "outbound_callback", "status_check"]).optional(), problemsOnly: z.enum(["1", "0", "true", "false"]).optional(), limit: limit100.optional(), before: z.string().max(100).optional() }).strict(),
    kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["logs[].id", "logs[].created_at", "logs[].direction", "logs[].session_id", "logs[].hubtel_order_id", "logs[].outcome", "logs[].ok", "logs[].http_status", "nextBefore"],
  }),
  mk({
    id: "ussd_hubtel.callback_log", page: HUBTEL_USSD, summary: "Show one Hubtel USSD callback log entry (summary only, no raw payload).",
    method: "GET", path: "/api/admin/ussd-hubtel/callback-logs/:id", params: { id: "uuid" }, kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["log.id", "log.created_at", "log.direction", "log.session_id", "log.hubtel_order_id", "log.outcome", "log.ok", "log.http_status"],
  }),
  mk({
    id: "ussd_hubtel.config.read", page: HUBTEL_USSD, summary: "Show the Hubtel USSD settings for both codes and whether the server is ready.",
    method: "GET", path: "/api/admin/ussd-hubtel/config", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["config", "mainLine", "env"],
  }),
  mk({
    id: "ussd_hubtel.config.set", page: HUBTEL_USSD, summary: "Change the Hubtel USSD settings: on/off, mode, menu items, wording, wallet payment on the main code.",
    method: "POST", path: "/api/admin/ussd-hubtel/config",
    body: z.object({
      line: z.literal("main").optional(), mode: z.enum(["main", "shop"]).optional(), enabled: bool.optional(), walletPayment: bool.optional(),
      visibility: z.object(Object.fromEntries(VIS_KEYS.map((k) => [k, bool.optional()]))).strict().optional(),
      brandName: asciiLine(30).optional(), welcome: asciiLine(60).optional(),
    }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: hubtelUssdConfigCard,
  }),
  mk({
    id: "ussd_hubtel.sessions", page: HUBTEL_USSD, summary: "List recent Hubtel USSD sessions with their outcome (no caller number).",
    method: "GET", path: "/api/admin/ussd-hubtel/sessions",
    query: z.object({ shopId: uuid.optional(), limit: limit100.optional(), before: z.string().max(100).optional(), includeShops: z.literal("1").optional() }).strict(),
    kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["sessions[].session_id", "sessions[].shop_name", "sessions[].mode", "sessions[].started_at", "sessions[].ended_at", "sessions[].exchanges", "sessions[].payment_state", "sessions[].amount", "sessions[].outcome", "nextBefore", "shops[].id", "shops[].code", "shops[].name"],
  }),
  mk({
    id: "ussd_hubtel.transactions", page: HUBTEL_USSD, summary: "List recent Hubtel USSD payments and those needing attention, with counts.",
    method: "GET", path: "/api/admin/ussd-hubtel/transactions", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["counts", "transactions[].session_id", "transactions[].state", "transactions[].callback_status", "transactions[].amount_paid", "transactions[].order_table", "transactions[].order_id", "transactions[].hubtel_order_id", "transactions[].review_reason", "transactions[].created_at"],
  }),
  mk({
    id: "ussd_hubtel.resolve", page: HUBTEL_USSD, summary: "Resolve a needs-review Hubtel USSD payment as fulfilled or not paid.",
    method: "POST", path: "/api/admin/ussd-hubtel/resolve",
    body: z.object({ sessionId: z.string().min(1).max(128), outcome: z.enum(["fulfilled", "not_paid"]), note: z.string().min(5).max(500) }).strict(),
    kind: "change", risk: "money", auth: "admin", card: hubtelResolveCard,
  }),
  mk({
    id: "ussd_hubtel.retry_callback", page: HUBTEL_USSD, summary: "Send the success callback to Hubtel again for a USSD payment.",
    method: "POST", path: "/api/admin/ussd-hubtel/retry-callback", body: z.object({ sessionId: z.string().min(1).max(128) }).strict(),
    kind: "change", risk: "money", auth: "admin", timeoutMs: 30000, card: hubtelRetryCbCard,
  }),

  // ---- text-to-buy
  mk({
    id: "text_to_buy.settings.read", page: TTB, summary: "Show the Text-to-Buy settings.",
    method: "GET", path: "/api/admin/text-to-buy", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["settingsDefaulted", "settings"],
  }),
  mk({
    id: "text_to_buy.settings.set", page: TTB, summary: "Change Text-to-Buy settings: switches, numbers, limits and reply transport.",
    method: "PUT", path: "/api/admin/text-to-buy", body: ttbBody, kind: "change", risk: "danger", auth: "admin", card: ttbSettingsCard,
  }),
  mk({
    id: "text_to_buy.action", page: TTB, summary: "Block or unblock a customer number on Text-to-Buy, or flag a message as misread.",
    method: "POST", path: "/api/admin/text-to-buy",
    body: z.object({ action: z.enum(["block", "unblock", "misread"]), sender: z.string().max(20).optional(), reason: z.string().max(200).optional(), messageId: uuid.optional() }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: ttbActionCard,
  }),
  mk({
    id: "text_to_buy.messages", page: TTB, summary: "List Text-to-Buy messages with their outcome (message text is not returned).",
    method: "GET", path: "/api/admin/text-to-buy/messages",
    query: z.object({ line: z.enum(["main", "shop"]).optional(), thread: z.string().max(20).optional(), sender: z.string().max(20).optional(), outcome: z.string().max(30).optional(), cursor: z.string().max(200).optional(), limit: limit100.optional() }).strict(),
    kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["rows[].id", "rows[].createdAt", "rows[].line", "rows[].sender", "rows[].direction", "rows[].readBy", "rows[].outcome", "rows[].misread", "rows[].orderLinkId", "nextCursor", "messages[].id", "messages[].createdAt", "messages[].line", "messages[].direction", "messages[].outcome", "messages[].misread"],
  }),
  mk({
    id: "text_to_buy.try", page: TTB, summary: "Run a pretend customer text through Text-to-Buy and show the reply (a dry run).",
    method: "POST", path: "/api/admin/text-to-buy/try",
    body: z.object({ line: z.enum(["main", "shop"]), sender: z.string().min(1).max(20), text: z.string().min(1).max(500) }).strict(),
    kind: "change", risk: "normal", auth: "admin", timeoutMs: 30000, card: ttbTryCard,
  }),

  // ---- packages
  mk({
    id: "packages.save", page: PACKAGES, summary: "Create a package, or change one: name, network, size, prices, availability flag and supplier cost.",
    method: "POST", path: "/api/admin/packages",
    body: z.object({ packageData: packageData, packageId: uuid.optional(), isUpdate: bool.optional() }).strict(),
    kind: "change", risk: "money", auth: "admin", card: packageSaveCard,
  }),
  mk({
    id: "packages.delete", page: PACKAGES, summary: "Delete a package for good (it also leaves every shop's list).",
    method: "DELETE", path: "/api/admin/packages/delete", body: z.object({ packageId: uuid }).strict(),
    kind: "change", risk: "money", auth: "admin", card: packageDeleteCard,
  }),
  mk({
    id: "packages.bulk_price", page: PACKAGES, summary: "Reprice many packages at once by a percentage or a price per GB (customer price and/or dealer price).",
    method: "POST", path: "/api/admin/packages/bulk-update-price",
    // Handler sets maxDuration 300 but only reads the chosen rows and writes one update each; capped at 100 packages to stay inside 60 s.
    body: z.object({ packageIds: z.array(uuid).min(1).max(100), updates: z.object({ price: priceField.optional(), dealer_price: priceField.optional() }).strict() }).strict(),
    kind: "change", risk: "money", auth: "admin", timeoutMs: 60000, card: bulkPriceCard,
  }),
  mk({
    id: "packages.toggle", page: PACKAGES, summary: "Enable or disable one package for customers.",
    method: "POST", path: "/api/admin/packages/toggle-availability", body: z.object({ packageId: uuid, isAvailable: bool }).strict(),
    kind: "change", risk: "money", auth: "admin", card: toggleAvailCard,
  }),
  mk({
    id: "packages.stock.read", page: PACKAGES, summary: "Show which networks are marked out of stock.",
    method: "GET", path: "/api/admin/packages/network-stock", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: STOCK_TRACKED_NETWORKS.map((n) => `status.${n}`),
  }),
  mk({
    id: "packages.stock.set", page: PACKAGES, summary: "Mark a whole network out of stock (switches its packages off) or back in stock.",
    method: "POST", path: "/api/admin/packages/network-stock",
    body: z.object({ network: z.enum(STOCK_TRACKED_NETWORKS as unknown as [string, ...string[]]), outOfStock: bool }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: networkStockCard,
  }),

  // ---- standard bundles
  mk({
    id: "standard_bundles.config.read", page: COMMISSION, summary: "Show the standard bundles settings (networks, hidden categories, Special Bundles).",
    method: "GET", path: "/api/admin/standard-bundles/config", kind: "lookup", risk: "normal", auth: "admin", resultKeep: ["config"],
  }),
  mk({
    id: "standard_bundles.config.set", page: COMMISSION, summary: "Change the standard bundles settings: master switch, networks, reference numbers and Special Bundles.",
    method: "POST", path: "/api/admin/standard-bundles/config",
    body: z.object({
      enabled: bool.optional(),
      networks: z.object({ MTN: netSetting.optional(), TELECEL: netSetting.optional(), AT: netSetting.optional() }).strict().optional(),
      special: z.object({ enabled: bool, multiples: z.array(int(1, 20)).min(1).max(10), unitAmount: ghsNum, unitValue: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/), ussdEnabled: bool.optional() }).strict().optional(),
    }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: bundlesConfigCard,
  }),
  mk({
    id: "standard_bundles.orders", page: COMMISSION, summary: "List standard bundle orders with status and what can be done to each.",
    method: "GET", path: "/api/admin/standard-bundles/orders",
    query: z.object({ q: z.string().max(100).optional(), status: z.string().max(30).optional(), network: z.enum(["MTN", "TELECEL", "AT"]).optional(), from: dateText.optional(), to: dateText.optional(), channel: z.enum(["dashboard", "storefront", "api", "bots"]).optional(), group: uuid.optional(), stats: z.literal("1").optional(), limit: limit100.optional(), offset: z.number().int().min(0).max(100000).optional() }).strict(),
    kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["total", "stats", "rows[].id", "rows[].reference_code", "rows[].network", "rows[].bundle_display", "rows[].amount", "rows[].paid_amount", "rows[].status", "rows[].payment_status", "rows[].channel", "rows[].created_at", "rows[].can_dispatch", "rows[].can_retry", "rows[].can_resend", "rows[].refund.action", "rows[].refund.reason"],
  }),
  mk({
    id: "standard_bundles.dispatch", page: COMMISSION, summary: "Send a paid standard bundle order that never reached Hubtel.",
    method: "POST", path: "/api/admin/standard-bundles/dispatch", body: orderIdBody, kind: "change", risk: "money", auth: "admin", timeoutMs: 30000,
    card: bundleSend("Send a standard bundle order to Hubtel", "The paid order is sent to Hubtel now as a purchase of the bundle shown for the recipient shown, paid from the Hubtel float. Refused if any Hubtel transaction already exists for it (a stuck claim may be released first)."),
  }),
  mk({
    id: "standard_bundles.retry", page: COMMISSION, summary: "Re-send a paid standard bundle order that Hubtel failed.",
    method: "POST", path: "/api/admin/standard-bundles/retry", body: orderIdBody, kind: "change", risk: "money", auth: "admin", timeoutMs: 30000,
    card: bundleSend("Retry a failed standard bundle order", "The failed paid order is reopened and sent to Hubtel AGAIN as a new purchase of the bundle shown for the recipient shown, paid from the Hubtel float. Refused unless the ledger shows every earlier attempt failed."),
  }),
  mk({
    id: "standard_bundles.resend", page: COMMISSION, summary: "Resend a completed Special Bundles unit the customer did not receive (one replacement order).",
    method: "POST", path: "/api/admin/standard-bundles/resend", body: orderIdBody, kind: "change", risk: "money", auth: "admin", timeoutMs: 30000,
    card: bundleSend("Resend a Special Bundles unit", "ONE replacement order (reference SBR-...) is created and bought again from the Hubtel float for the same recipient. The customer is not charged again and the replacement cannot be refunded. Only one replacement per unit."),
  }),
  mk({
    id: "standard_bundles.refund", page: COMMISSION, summary: "Refund a paid standard bundle order that never reached Hubtel to the customer's wallet.",
    method: "POST", path: "/api/admin/standard-bundles/refund", body: z.object({ orderId: uuid, note: note500 }).strict(),
    kind: "change", risk: "money", auth: "admin", timeoutMs: 30000, card: bundleRefundCard,
  }),

  // ---- utility bills
  mk({
    id: "utility_bills.config.read", page: BILLS, summary: "Show the utility bills settings.",
    method: "GET", path: "/api/admin/utility-bills/config", kind: "lookup", risk: "normal", auth: "admin", resultKeep: ["config"],
  }),
  mk({
    id: "utility_bills.config.set", page: BILLS, summary: "Change the utility bills settings: master switch, automatic payment, and each biller's switch and limits.",
    method: "POST", path: "/api/admin/utility-bills/config",
    body: z.object({
      enabled: bool.optional(), autoFulfil: bool.optional(),
      billers: z.object(Object.fromEntries(BILLER_KEYS.map((k) => [k, billerSetting.optional()]))).strict().optional(),
    }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: billsConfigCard,
  }),
  mk({
    id: "utility_bills.orders", page: BILLS, summary: "List utility bill orders with status and what can be done to each.",
    method: "GET", path: "/api/admin/utility-bills/orders",
    query: z.object({ q: z.string().max(100).optional(), status: z.string().max(30).optional(), biller: billerKey.optional(), paidOnly: z.enum(["1", "true"]).optional(), from: dateText.optional(), to: dateText.optional(), view: z.enum(["all", "refund", "refunded"]).optional(), channel: z.enum(["dashboard", "storefront", "api", "bots"]).optional(), stats: z.literal("1").optional(), limit: limit100.optional(), offset: z.number().int().min(0).max(100000).optional() }).strict(),
    kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["total", "stats", "rows[].id", "rows[].reference_code", "rows[].biller", "rows[].amount", "rows[].paid_amount", "rows[].status", "rows[].payment_status", "rows[].failure_reason", "rows[].channel", "rows[].created_at", "rows[].can_dispatch", "rows[].can_retry", "rows[].stuck_claim", "rows[].refund.action", "rows[].refund.reason"],
  }),
  mk({
    id: "utility_bills.dispatch", page: BILLS, summary: "Send a paid utility bill order that never reached Hubtel.",
    method: "POST", path: "/api/admin/utility-bills/dispatch", body: orderIdBody, kind: "change", risk: "money", auth: "admin", timeoutMs: 30000,
    card: billSend("Send a utility bill order to Hubtel", "The paid bill is sent to Hubtel now: the amount shown is paid to the biller for the meter or account shown, from the Hubtel float. Refused if any Hubtel transaction already exists for it (a stuck claim may be released first)."),
  }),
  mk({
    id: "utility_bills.retry", page: BILLS, summary: "Re-send a paid utility bill order that Hubtel failed.",
    method: "POST", path: "/api/admin/utility-bills/retry", body: orderIdBody, kind: "change", risk: "money", auth: "admin", timeoutMs: 30000,
    card: billSend("Retry a failed utility bill order", "The failed paid bill is reopened and sent to Hubtel AGAIN as a new payment of the amount shown for the meter or account shown, from the Hubtel float. Refused unless the ledger shows every earlier attempt failed."),
  }),
  mk({
    id: "utility_bills.refund", page: BILLS, summary: "Refund a paid utility bill order that failed or never reached Hubtel.",
    method: "POST", path: "/api/admin/utility-bills/refund", body: z.object({ orderId: uuid, note: note500, force: bool.optional() }).strict(),
    kind: "change", risk: "money", auth: "admin", timeoutMs: 30000, card: billRefundCard,
  }),

  // ---- hubtel commission services
  mk({
    id: "hubtel_cs.config.read", page: COMMISSION, summary: "Show the Hubtel Commission Services settings and whether the server is ready.",
    method: "GET", path: "/api/admin/hubtel-cs/config", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["config", "env.ready", "env.missing", "services[].key", "services[].label", "services[].kind"],
  }),
  mk({
    id: "hubtel_cs.config.set", page: COMMISSION, summary: "Change the Hubtel Commission settings: master switch, mode, low float alert, per-service switches, clear the pause.",
    method: "POST", path: "/api/admin/hubtel-cs/config",
    body: z.object({
      enabled: bool.optional(), mode: z.enum(["direct", "relay"]).optional(),
      lowBalanceThreshold: z.number().finite().positive().max(10_000_000).nullable().optional(),
      services: z.object(Object.fromEntries(HUBTEL_CS_SERVICE_KEYS.map((k) => [k, bool.optional()]))).strict().optional(),
      paused: z.literal(false).optional(),
    }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: csConfigCard,
  }),
  mk({
    id: "hubtel_cs.transactions", page: COMMISSION, summary: "List Hubtel Commission transactions, with what can be retried or refunded.",
    method: "GET", path: "/api/admin/hubtel-cs/transactions",
    query: z.object({ state: z.enum(["attention", "created", "pending", "fulfilled", "failed", "needs_review"]).optional(), q: z.string().max(100).optional(), limit: limit100.optional(), offset: z.number().int().min(0).max(100000).optional() }).strict(),
    kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["total", "stats", "rows[].client_reference", "rows[].service_key", "rows[].destination", "rows[].amount", "rows[].state", "rows[].failure_reason", "rows[].order_table", "rows[].order_id", "rows[].created_at", "rows[].refundable", "rows[].retryable", "rows[].retry_block"],
  }),
  mk({
    id: "hubtel_cs.check_status", page: COMMISSION, summary: "Ask Hubtel for the live status of one transaction and record it.",
    method: "POST", path: "/api/admin/hubtel-cs/check-status", body: z.object({ ref: refText }).strict(),
    kind: "change", risk: "money", auth: "admin", timeoutMs: 30000, card: csCheckCard,
  }),
  mk({
    id: "hubtel_cs.refund", page: COMMISSION, summary: "Refund a failed Hubtel transaction to the customer's wallet.",
    method: "POST", path: "/api/admin/hubtel-cs/refund", body: z.object({ ref: refText, force: bool.optional() }).strict(),
    kind: "change", risk: "money", auth: "admin", card: csRefundCard,
  }),
  mk({
    id: "hubtel_cs.resolve", page: COMMISSION, summary: "Mark a stuck Hubtel transaction fulfilled or failed by hand, with a note.",
    method: "POST", path: "/api/admin/hubtel-cs/resolve", body: z.object({ ref: refText, outcome: z.enum(["fulfilled", "failed"]), note: note500 }).strict(),
    kind: "change", risk: "money", auth: "admin", card: csResolveCard,
  }),
  mk({
    id: "hubtel_cs.retry", page: COMMISSION, summary: "Re-send the order behind a failed Hubtel transaction as a new purchase.",
    method: "POST", path: "/api/admin/hubtel-cs/retry", body: z.object({ ref: refText }).strict(),
    kind: "change", risk: "money", auth: "admin", timeoutMs: 30000, card: csRetryCard,
  }),
  mk({
    id: "hubtel_cs.test_purchase", page: COMMISSION, summary: "Send a real test purchase (up to GHS 5) to Hubtel for a number, meter or account.",
    method: "POST", path: "/api/admin/hubtel-cs/test-purchase",
    body: z.object({ confirm: z.literal(true), serviceKey: serviceKey, amount: z.number().finite().min(0.01).max(5), destination: z.string().min(1).max(60), bundle: z.string().max(120).optional() }).strict(),
    kind: "change", risk: "money", auth: "admin", timeoutMs: 60000, card: csTestCard,
  }),

  // ---- airtime
  mk({
    id: "airtime.list", page: AIRTIME, summary: "List airtime orders with status, amounts and totals.",
    method: "GET", path: "/api/admin/airtime/list",
    query: z.object({ date: z.union([dateText, z.literal("all")]).optional(), network: z.string().max(20).optional(), status: z.string().max(20).optional(), search: z.string().max(100).optional(), page: page.optional(), limit: limit100.optional() }).strict(),
    kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["total", "page", "limit", "stats", "orders[].id", "orders[].reference_code", "orders[].network", "orders[].beneficiary_phone", "orders[].airtime_amount", "orders[].total_paid", "orders[].status", "orders[].payment_status", "orders[].created_at", "orders[].can_send_hubtel"],
  }),
  mk({
    id: "airtime.batches", page: AIRTIME, summary: "List recent airtime download batches.",
    method: "GET", path: "/api/admin/airtime/batches", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["data[].id", "data[].created_at"],
  }),
  mk({
    id: "airtime.digiwapy_balance", page: AIRTIME, summary: "Show the balance held at the Digiwapy airtime supplier.",
    method: "GET", path: "/api/admin/airtime/digiwapy-balance", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["balance", "currency", "last_updated"],
  }),
  mk({
    id: "airtime.settings.read", page: "/admin/airtime/settings", summary: "Show the airtime settings: limits, switches, fees and providers per network.",
    method: "GET", path: "/api/admin/airtime/settings", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: [...Object.keys(airtimeSettingsShape).map((k) => `settings.${k}`), "digiwapy_configured", "hubtel"],
  }),
  mk({
    id: "airtime.settings.set", page: "/admin/airtime/settings", summary: "Change airtime settings: min and max amount, per-network switches, fee rates and the fulfilment provider.",
    method: "PUT", path: "/api/admin/airtime/settings", body: z.object({ settings: optionalShape(airtimeSettingsShape) }).strict(),
    kind: "change", risk: "money", auth: "admin", card: airtimeSettingsCard,
  }),
  mk({
    id: "airtime.action", page: AIRTIME, summary: "Mark one airtime order completed or failed by hand (a failed order is refunded).",
    method: "POST", path: "/api/admin/airtime/action",
    body: z.object({ orderId: uuid, action: z.enum(["completed", "failed"]), notes: z.string().max(500).optional() }).strict(),
    kind: "change", risk: "money", auth: "admin", card: airtimeActionCard,
  }),
  mk({
    id: "airtime.bulk_status", page: AIRTIME, summary: "Mark several airtime orders completed or failed by hand (failed ones are refunded).",
    method: "POST", path: "/api/admin/airtime/bulk-update-status",
    body: z.object({ orderIds: z.array(uuid).min(1).max(25), status: z.enum(["completed", "failed"]), notes: z.string().max(500).optional() }).strict(),
    kind: "change", risk: "money", auth: "admin", timeoutMs: 60000, card: airtimeBulkCard,
  }),
  mk({
    id: "airtime.auto_fulfill", page: AIRTIME, summary: "Send pending airtime orders to the Digiwapy supplier now.",
    method: "POST", path: "/api/admin/airtime/auto-fulfill", body: z.object({ orderIds: z.array(uuid).min(1).max(25) }).strict(),
    kind: "change", risk: "money", auth: "admin", timeoutMs: 60000, card: airtimeAutoCard,
  }),
  mk({
    id: "airtime.hubtel_send", page: AIRTIME, summary: "Send a paid, stuck airtime order to Hubtel.",
    method: "POST", path: "/api/admin/airtime/hubtel-send", body: orderIdBody, kind: "change", risk: "money", auth: "admin", timeoutMs: 30000, card: airtimeHubtelCard,
  }),
  mk({
    id: "airtime.sync_digiwapy", page: AIRTIME, summary: "Check Digiwapy for every airtime order it is still processing and update their status.",
    method: "POST", path: "/api/admin/airtime/sync-digiwapy", kind: "change", risk: "money", auth: "admin", timeoutMs: 60000, card: airtimeSyncCard,
  }),

  // ---- results checker
  mk({
    id: "results_checker.list", page: RC, summary: "List results checker voucher orders with status and totals.",
    method: "GET", path: "/api/admin/results-checker/list",
    query: z.object({ status: z.string().max(30).optional(), examBoard: z.string().max(20).optional(), date: dateText.optional(), search: z.string().max(100).optional(), page: page.optional(), limit: limit100.optional() }).strict(),
    kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["total", "page", "limit", "stats", "orders[].id", "orders[].reference_code", "orders[].exam_board", "orders[].total_paid", "orders[].status", "orders[].payment_status", "orders[].created_at"],
  }),
  mk({
    id: "results_checker.inventory", page: RC, summary: "Show voucher stock by exam board and status (ids and status only: no PINs or serials).",
    method: "GET", path: "/api/admin/results-checker/inventory",
    query: z.object({ examBoard: z.string().max(20).optional(), status: z.string().max(20).optional(), batchId: uuid.optional(), page: page.optional(), limit: limit100.optional() }).strict(),
    kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["total", "page", "limit", "summary", "items[].id", "items[].exam_board", "items[].status", "items[].batch_id"],
  }),
  mk({
    id: "results_checker.invalidate", page: RC, summary: "Mark vouchers invalid so they are never sold.",
    method: "PATCH", path: "/api/admin/results-checker/inventory",
    body: z.object({ action: z.literal("mark_invalid"), ids: z.array(uuid).min(1).max(100) }).strict(),
    kind: "change", risk: "money", auth: "admin", card: rcInventoryCard,
  }),
  mk({
    id: "results_checker.action", page: RC, summary: "Deliver vouchers to a paid order, or cancel an order (refunding a signed-in customer).",
    method: "POST", path: "/api/admin/results-checker/action",
    body: z.object({ orderId: uuid, action: z.enum(["deliver", "refund", "failed"]), notes: z.string().max(500).optional() }).strict(),
    kind: "change", risk: "money", auth: "admin", timeoutMs: 60000, card: rcActionCard,
  }),
  mk({
    id: "results_checker.settings.read", page: RC, summary: "Show the results checker prices, switches, markups and limits.",
    method: "GET", path: "/api/admin/results-checker/settings", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: Object.keys(rcSettingsShape).map((k) => `settings.${k}`),
  }),
  mk({
    id: "results_checker.settings.set", page: RC, summary: "Change results checker prices, bulk prices, markups, switches and limits.",
    method: "PUT", path: "/api/admin/results-checker/settings", body: z.object({ settings: optionalShape(rcSettingsShape) }).strict(),
    kind: "change", risk: "money", auth: "admin", card: rcSettingsCard,
  }),
  mk({
    id: "results_check_requests.list", page: RCR, summary: "List paid results check requests by status.",
    method: "GET", path: "/api/admin/results-check-requests",
    query: z.object({ status: z.string().max(30).optional(), page: page.optional() }).strict(),
    kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["count", "page", "limit", "data[].id", "data[].exam_board", "data[].index_number", "data[].status", "data[].channel", "data[].payment_status", "data[].created_at"],
  }),
  mk({
    id: "results_check_requests.update", page: RCR, summary: "Update a results check request: status, result text or file, and optionally deliver it to the customer.",
    method: "PATCH", path: "/api/admin/results-check-requests",
    body: z.object({
      id: uuid, status: z.string().min(1).max(30).optional(), result_data: z.string().max(4000).optional(),
      media_url: z.string().url().max(500).refine((v) => v.startsWith("https://"), "must be an https link").optional(),
      media_type: z.enum(["image", "document", "video"]).optional(), deliver: bool.optional(), reason: z.string().max(200).optional(),
    }).strict(),
    kind: "change", risk: "normal", auth: "admin", timeoutMs: 60000, card: rcRequestsCard,
  }),
  mk({
    id: "results_check_requests.phones.read", page: RCR, summary: "Show the admin WhatsApp numbers alerted for results check requests.",
    method: "GET", path: "/api/admin/results-check-requests/admin-phones", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["phones"],
  }),
  mk({
    id: "results_check_requests.phones.set", page: RCR, summary: "Set the admin WhatsApp numbers alerted for results check requests.",
    method: "PUT", path: "/api/admin/results-check-requests/admin-phones",
    body: z.object({ phones: z.array(z.string().min(9).max(20)).max(20) }).strict(),
    kind: "change", risk: "danger", auth: "admin", card: rcPhonesCard,
  }),
  mk({
    id: "results_check_settings.read", page: RCR, summary: "Show whether the results check service is on and its fee.",
    method: "GET", path: "/api/admin/results-check-settings", kind: "lookup", risk: "normal", auth: "admin",
    resultKeep: ["enabled", "fee"],
  }),
  mk({
    id: "results_check_settings.set", page: RCR, summary: "Switch the results check service on or off and set its fee per request.",
    method: "PUT", path: "/api/admin/results-check-settings",
    body: z.object({ enabled: bool.optional(), fee: z.number().finite().min(0).max(1000).optional() }).strict(),
    kind: "change", risk: "money", auth: "admin", card: rcCheckSettingsCard,
  }),
]
