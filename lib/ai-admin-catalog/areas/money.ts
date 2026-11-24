import { z } from "zod"
import type { CardCtx, CardLine, CatalogEntry, EntryInput } from "../types"
import { pageTitleFor } from "../pages"
import { userLabel } from "@/lib/ai-drafts/user-label"
import { loadRefundableOrders } from "@/lib/refunds/orders"
import { orderEligibility } from "@/lib/refunds/eligibility"
import { planClawback } from "@/lib/refunds/clawback"
import { validateRefundAmount } from "@/lib/refunds/amounts"
import { COMMISSION_TABLES, ORDER_TABLES, isWalletOnlyTable, isCommissionTable, type OrderTable, type RefundableOrder } from "@/lib/refunds/types"
import { getCashbackConfig, mergeCashbackPatch, validateCashbackPatch, MAX_PAYMENT_FEE, MAX_RATE, MAX_SHARE } from "@/lib/cashback/config"
import { loadMomoClaimSettings } from "@/lib/momo-claim/settings"

// Money group: /api/admin/ refunds, withdrawals, cashback, sub-agent-profits, profits-history, momo-claims, subscriptions,
// subscription-plans. Every change here moves money or decides how much money moves, so every card says in plain words
// WHOSE money, HOW MUCH (GHS 0.00), WHERE it goes (full number or account: a payout destination is never masked), what
// status changes, and every other effect (wallet credits, profit clawbacks, texts and notices, admin alerts).
//
// Typed tool: withdrawals approve / reject / complete are done by prepare_withdrawal_action. It posts exactly
// {withdrawalId} (approve, complete) or {withdrawalId, reason} (reject) to these routes (lib/ai-drafts/execute.ts), so
// those three entries mirror that body and carry no card of their own.
//
// Where a payout goes is decided by the server, never by the request: a refund payout goes to the number that paid
// (order.payment.payerPhone, loaded the same way the route loads it), a withdrawal to the account saved on the request.
// The cards therefore READ that destination and show it in full.
//
// OTPs: refunds/:id/otp and withdrawals/submit-transfer-otp take the one-time payout code in the body. It is a
// secretFields entry (secure box), never part of a schema, and no card ever echoes it.
//
// Auth notes: subscriptions, subscription-plans and the two sub-agent-profits routes do their own bearer-token check
// (users.role = 'admin'), the same bar as verifyAdminAccess, so they are listed as "other". Every other route here uses
// verifyAdminAccess (directly or through the hubtel-cs requireAdmin wrapper).
//
// Left out on purpose (see EXCLUDED): withdrawals/bulk-approve (maxDuration 300, serial real payouts: use
// prepare_withdrawal_action, which approves one by one), withdrawals/list (bare JSON array: use list_withdrawals),
// momo-claims/reconcile POST (a statement CSV of up to 5 MB in the body) and sync-shop-balances (a GET that loops over
// every shop with one write each: use withdrawals/recalibrate, one database call).
//
// Left out of the schemas on purpose: momo-claims GET ?raw (raw SMS text holds names and numbers) and profits-history
// ?search (it loads the whole profits table into memory, far past the time limit on a big table).

const uuid = z.string().uuid()
const pageNo = z.number().int().min(1).max(1000)
const dateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const reason200 = z.string().min(1).max(200)

const where = (page: string) => ({ page, pageTitle: pageTitleFor(page) ?? page })

const ghs = (n: unknown) => `GHS ${Number(n).toFixed(2)}`

type Card = { summary: string; lines: CardLine[] }
type Obj = Record<string, unknown>

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

const asBody = (i: EntryInput): Obj => (i.body ?? {}) as Obj
const str = (v: unknown): string => (typeof v === "string" ? v : "")
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
const yn = (b: unknown): string => (b === true ? "on" : "off")

/** "Name · masked contact" of an existing account (old values may be masked), or the short id. */
async function who(ctx: CardCtx, id: string): Promise<string> {
  if (!id) return "(no user id)"
  const row = await readRow(() =>
    ctx.db.from("users").select("first_name, last_name, phone_number, email").eq("id", id).maybeSingle(),
  )
  return `${userLabel(id, row as never)} (id ${id})`
}

// ---------------------------------------------------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------------------------------------------------

// Mirror of lib/refunds/gateways/index.ts (that module creates service clients on import, so it is not imported here).
const REFUND_GATEWAYS = ["paystack", "hubtel_send", "paystack_payout", "moolre", "hubtel", "wallet", "manual"] as const
type GatewayId = (typeof REFUND_GATEWAYS)[number]

const MANUAL_REF = z.string().max(100).regex(/^[^\u0000-\u001f\u007f\p{Cf}]*$/u)

async function loadOrder(ctx: CardCtx, table: string, id: string): Promise<RefundableOrder | null> {
  if (!id || !(ORDER_TABLES as string[]).includes(table)) return null
  try {
    return (await loadRefundableOrders(ctx.db, [{ table: table as OrderTable, id }]))[0] ?? null
  } catch {
    return null
  }
}

const PAYOUT_GATEWAYS: GatewayId[] = ["moolre", "paystack_payout", "hubtel_send"]

/** Whose money and where it goes, for one gateway. The destination is what the route will really use. */
async function destinationLines(ctx: CardCtx, o: RefundableOrder, gw: string, amount: number): Promise<CardLine[]> {
  const out: CardLine[] = []
  const phone = o.payment.payerPhone
  switch (gw) {
    case "wallet": {
      out.push({ label: "Where it goes", value: `${ghs(amount)} is added to the Datagod wallet of ${o.payment.walletUserId ? await who(ctx, o.payment.walletUserId) : "(no wallet account found: the refund is refused)"}` })
      break
    }
    case "paystack":
      out.push({
        label: "Where it goes",
        value: `${ghs(amount)} is reversed by Paystack back to whoever paid the original Paystack charge${o.payment.reference ? ` (payment reference ${o.payment.reference})` : " (no Paystack reference found: the refund is refused)"}`,
      })
      break
    case "hubtel":
      out.push({ label: "Where it goes", value: `${ghs(amount)} is refunded by Hubtel to the payer of the original Hubtel payment (the full payment only)` })
      break
    case "moolre":
    case "paystack_payout":
    case "hubtel_send": {
      const rail = gw === "moolre" ? "Moolre" : gw === "hubtel_send" ? "Hubtel Send Money" : "a Paystack payout"
      out.push({
        label: "Where it goes",
        value: phone
          ? `${ghs(amount)} is sent by ${rail} to MoMo number ${phone} (the number that paid this order; it is not taken from your request)`
          : `${ghs(amount)} by ${rail} to the paying number, but no paying number is recorded on this order, so it is refused`,
      })
      break
    }
    case "manual":
      out.push({
        label: "Where it goes",
        value: `NO money is sent by the system. You must already have sent ${ghs(amount)} to the customer yourself (MoMo, bank or cash). This only records that you did.`,
      })
      break
    default:
      out.push({ label: "Where it goes", value: `Unknown refund method "${gw}": the request is refused` })
  }
  return out
}

function notifyLines(o: RefundableOrder, gw: string, amount: number): CardLine[] {
  const lines: CardLine[] = []
  const walletOnly = isWalletOnlyTable(o.table)
  const smsTo = walletOnly
    ? "the account holder's phone on file"
    : isCommissionTable(o.table) || gw === "manual"
      ? o.payment.payerPhone
      : (o.payment.payerPhone ?? o.recipientPhone)
  lines.push({
    label: "Customer message",
    value: smsTo
      ? `When the refund completes an SMS saying ${ghs(amount)} was refunded is sent to ${smsTo}${walletOnly ? ", plus an in-app notice to the buyer" : ""}.`
      : "No customer SMS: no safe number is on record.",
  })
  return lines
}

function clawbackLines(o: RefundableOrder): CardLine[] {
  if (!o.owners.length) {
    return [{ label: "Shop profit", value: "No shop share on this order, so nothing is taken back from any shop." }]
  }
  const plan = planClawback(o.owners)
  const lines: CardLine[] = plan.lines.map((l, i) => ({
    label: `Shop profit ${plan.lines.length > 1 ? i + 1 : ""}`.trim(),
    value: `Takes back ${ghs(l.fromProfit)} from the shop's available profit${l.fromWallet > 0 ? ` and ${ghs(l.fromWallet)} from the owner's wallet` : ""} (credited cut ${ghs(l.credited)}, pending cut ${ghs(l.pending)} is cancelled).${l.shortfall > 0 ? ` SHORT by ${ghs(l.shortfall)}: the refund is refused.` : ""} The owner gets an in-app notice.`,
  }))
  return lines
}

interface RefundParams {
  table: string
  orderId: string
  gateway: string
  amount: number | null
  confirmOverride?: boolean
  manualReference?: string
  lead?: CardLine[]
}

async function refundCard(ctx: CardCtx, p: RefundParams): Promise<Card> {
  const lines: CardLine[] = [...(p.lead ?? [])]
  const amount = p.amount ?? 0
  const o = await loadOrder(ctx, p.table, p.orderId)
  if (!o) {
    lines.push(
      { label: "Order", value: `${p.table} · ${p.orderId}` },
      { label: "Method", value: p.gateway },
      { label: "Amount", value: p.amount === null ? "(not given)" : ghs(amount) },
      { label: "Problem", value: "The order could not be read just now, so who gets the money and the order status could not be checked. The request still applies the checks when it runs." },
    )
    return { summary: `Refund ${p.amount === null ? "an order" : ghs(amount)} on a ${p.table} order via ${p.gateway}`, lines }
  }
  lines.push(
    { label: "Order", value: `${o.packageLabel || "order"} ${o.network} · ${o.table} · ${o.id}` },
    { label: "Payment reference", value: o.payment.reference ?? "(none on record)" },
    { label: "Customer paid", value: `${ghs(o.paid)}${o.gatewayFee ? ` (gateway fee ${ghs(o.gatewayFee)})` : ""}` },
    { label: "Refund amount", value: ghs(amount) },
  )
  const bad = validateRefundAmount(amount, o.paid)
  if (bad) lines.push({ label: "Problem", value: `${bad}: the request is refused.` })
  lines.push(...(await destinationLines(ctx, o, p.gateway, amount)))
  if (PAYOUT_GATEWAYS.includes(p.gateway as GatewayId) && o.payment.gateway === "wallet") {
    lines.push({ label: "Problem", value: "This order was paid from a wallet: a MoMo payout is refused, refund it to the wallet instead." })
  }
  lines.push({
    label: "Order status",
    value: `Now "${o.orderStatus}" (payment "${o.paymentStatus}"). It is put on a refund hold when this is sent, becomes "refunded" when the payout completes, and goes back to its earlier status if the payout fails.`,
  })
  const el = orderEligibility(o)
  if (!el.eligible) lines.push({ label: "Problem", value: `${el.reason} The request is refused.` })
  else if (el.warning) {
    lines.push({
      label: "Warning",
      value: p.confirmOverride === true ? el.warning : `${el.warning} The request is refused unless confirmOverride is true.`,
    })
  }
  if (p.gateway === "paystack_payout") {
    lines.push({ label: "Next step", value: "A Paystack payout stays 'awaiting OTP' and pays nothing until you enter its one-time code on a separate card." })
  }
  if (p.gateway === "manual") {
    lines.push({ label: "Reference", value: p.manualReference?.trim() ? p.manualReference.trim() : "(none given)" })
  } else if (p.manualReference) {
    lines.push({ label: "Note", value: "The reference you gave is ignored: it is only kept for manual refunds." })
  }
  lines.push(...clawbackLines(o), ...notifyLines(o, p.gateway, amount))
  lines.push({ label: "Record", value: "The refund is written to the refund history and the admin audit log. A payout that has been sent cannot be pulled back." })
  return { summary: `Refund ${ghs(amount)} on an order via ${p.gateway}`, lines }
}

async function refundExecuteCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  return refundCard(ctx, {
    table: str(b.table),
    orderId: str(b.orderId),
    gateway: str(b.gateway),
    amount: num(b.amount),
    confirmOverride: b.confirmOverride === true,
    manualReference: str(b.manualReference) || undefined,
  })
}

async function refundManualCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const table = str(b.table)
  const id = str(b.orderId)
  const o = await loadOrder(ctx, table, id)
  const lines: CardLine[] = []
  if (!o) {
    lines.push({ label: "Order", value: `${table} · ${id}` }, { label: "Note", value: str(b.note) }, {
      label: "Problem",
      value: "The order could not be read just now. The request still applies its checks when it runs.",
    })
    return { summary: "Mark a storefront or bot order as refunded by hand", lines }
  }
  lines.push(
    { label: "Order", value: `${o.packageLabel || "order"} ${o.network} · ${o.table} · ${o.id}` },
    { label: "Customer paid", value: ghs(o.paid) },
    { label: "Refund amount", value: `${ghs(o.paid)} (always the full amount paid; not editable)` },
    { label: "Where it goes", value: `NO money is sent by the system. You must already have paid ${ghs(o.paid)} back to the customer yourself${o.payment.payerPhone ? ` (the paying number on record is ${o.payment.payerPhone})` : ""}. This only records it.` },
    { label: "Your note", value: str(b.note) },
    {
      label: "Order status",
      value: o.orderStatus === "refunded"
        ? "Already refunded: nothing changes."
        : `Now "${o.orderStatus}" (payment "${o.paymentStatus}"). It becomes "refunded" (bills and bundles also get payment status "refunded"), and your note is saved on the order.`,
    },
  )
  const el = orderEligibility(o)
  if (o.orderStatus !== "refunded" && !el.eligible) lines.push({ label: "Problem", value: `${el.reason} The request is refused.` })
  else if (o.orderStatus !== "refunded" && el.eligible && el.warning) {
    lines.push({ label: "Warning", value: b.confirmOverride === true ? el.warning : `${el.warning} The request is refused unless confirmOverride is true.` })
  }
  if (!o.evidence.commission?.storefront) lines.push({ label: "Problem", value: "Not a storefront or bot order: the request is refused." })
  lines.push(...clawbackLines(o), ...notifyLines(o, "manual", o.paid))
  lines.push({ label: "Record", value: "Written to the refund history and the admin audit log." })
  return { summary: `Mark ${ghs(o.paid)} as refunded by hand on an order`, lines }
}

async function storedRefund(ctx: CardCtx, id: string): Promise<Obj | null> {
  return readRow(() =>
    ctx.db
      .from("order_refunds")
      .select("id, order_table, order_id, gateway, amount, status, destination_phone, wallet_user_id, gateway_ref, prev_status, created_at")
      .eq("id", id)
      .maybeSingle(),
  )
}

function storedLines(r: Obj | null, id: string): CardLine[] {
  if (!r) return [{ label: "Refund", value: `${id} (could not be read just now)` }]
  const lines: CardLine[] = [
    { label: "Refund", value: `${id} · ${str(r.gateway)} · ${ghs(r.amount)} · status ${str(r.status)}` },
    { label: "Order", value: `${str(r.order_table)} · ${str(r.order_id)}` },
  ]
  if (r.destination_phone) lines.push({ label: "Payout number", value: str(r.destination_phone) })
  return lines
}

async function refundRetryCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(i.params?.id)
  const b = asBody(i)
  const prev = await storedRefund(ctx, id)
  const lead: CardLine[] = [
    ...storedLines(prev, id),
    { label: "Retry", value: "This starts a NEW refund for the same order (the old one failed). Eligibility, balances and the method are all checked again." },
  ]
  if (prev && str(prev.status) !== "failed") {
    lead.push({ label: "Problem", value: `Only failed refunds can be retried (this one is "${str(prev.status)}"): the request is refused.` })
  }
  const gateway = str(b.gateway) || str(prev?.gateway)
  if (gateway === "manual") lead.push({ label: "Problem", value: "Manual refunds are started from the refund dialog, not retried: the request is refused." })
  const amount = num(b.amount) ?? (prev ? num(Number(prev.amount)) : null)
  return refundCard(ctx, {
    table: str(prev?.order_table),
    orderId: str(prev?.order_id),
    gateway,
    amount,
    confirmOverride: b.confirmOverride === true,
    lead,
  })
}

async function refundCancelCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(i.params?.id)
  const r = await storedRefund(ctx, id)
  const lines = storedLines(r, id)
  if (r && str(r.status) !== "awaiting_otp") {
    lines.push({ label: "Problem", value: `Only refunds waiting for their one-time code can be cancelled (this one is "${str(r.status)}"): the request is refused.` })
  }
  lines.push(
    { label: "What it does", value: "Asks the gateway first. If the payout was NOT made, the refund is cancelled: the shop's profit that was taken back is restored and the order goes back to its earlier status" + (r?.prev_status ? ` ("${str(r.prev_status)}")` : "") + ". Nothing is paid out." },
    { label: "If it was paid", value: "If the gateway says the payout actually went through, the refund is completed instead (order becomes refunded, customer is told). If the gateway cannot be reached, nothing changes." },
    { label: "Timing", value: "Refused for a minute after the payout was created." },
  )
  return { summary: "Cancel a refund payout that is waiting for its one-time code", lines }
}

async function refundReconcileCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(i.params?.id)
  const r = await storedRefund(ctx, id)
  const lines = storedLines(r, id)
  if (r && !["reserved", "processing", "awaiting_otp"].includes(str(r.status))) {
    lines.push({ label: "Problem", value: `Only unfinished refunds can be re-checked (this one is "${str(r.status)}"): the request is refused.` })
  }
  lines.push(
    { label: "What it does", value: "Asks the gateway what happened to this payout and records the answer. No new payout is created." },
    { label: "If paid", value: "The refund is completed: the order becomes \"refunded\", the shop's profit stays taken back, and the customer gets the refund SMS." },
    { label: "If failed", value: "The refund is marked failed: the shop's profit is restored and the order goes back to its earlier status; it can then be retried." },
    { label: "If unclear", value: "Nothing is released; it stays in progress." },
    { label: "Timing", value: "Refused for a few minutes after the payout was started." },
  )
  return { summary: "Re-check a refund payout with its gateway and record the result", lines }
}

async function refundOtpCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(i.params?.id)
  const r = await storedRefund(ctx, id)
  const lines = storedLines(r, id)
  if (r && str(r.status) !== "awaiting_otp") {
    lines.push({ label: "Problem", value: `This refund is not waiting for a code (it is "${str(r.status)}"): the request is refused.` })
  }
  lines.push(
    { label: "One-time code", value: "Typed in the secure box on this card; the assistant never sees it" },
    { label: "What it does", value: `Releases the Paystack MoMo payout of ${r ? ghs(r.amount) : "the refund amount"}${r?.destination_phone ? ` to ${str(r.destination_phone)}` : ""}. Once released the money cannot be pulled back.` },
    { label: "If the code is wrong", value: "Paystack refuses it and the refund stays waiting; nothing is paid." },
    { label: "After it works", value: "The refund completes: order becomes \"refunded\" and the customer gets the refund SMS." },
  )
  return { summary: "Release a Paystack refund payout with its one-time code", lines }
}

async function refundNeverPaidCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(i.params?.id)
  const r = await storedRefund(ctx, id)
  const lines = storedLines(r, id)
  if (r && str(r.gateway) !== "hubtel_send") lines.push({ label: "Problem", value: "This is not a Hubtel payout: the request is refused." })
  if (r && !["processing", "reserved"].includes(str(r.status))) {
    lines.push({ label: "Problem", value: `Only an unfinished Hubtel payout can be marked failed (this one is "${str(r.status)}"): the request is refused.` })
  }
  lines.push(
    { label: "What it does", value: "Asks Hubtel again. Only if Hubtel clearly says the payout failed (or has no record of one it never accepted) is it marked failed." },
    { label: "Effect", value: "The shop's profit that was taken back is restored and the order can be refunded again. Marking a payout failed that really paid would let the customer be paid TWICE." },
    { label: "Timing", value: "Refused until an hour after the payout was started." },
  )
  return { summary: "Mark a stuck Hubtel refund payout as never paid", lines }
}

async function refundGatewayStatusCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(i.params?.id)
  const r = await storedRefund(ctx, id)
  const lines = storedLines(r, id)
  lines.push({ label: "What it does", value: "Asks Paystack or Hubtel what it says about this payout. Nothing is paid, settled or changed." })
  if (r && !["paystack", "hubtel_send"].includes(str(r.gateway))) {
    lines.push({ label: "Problem", value: "Only Paystack reversals and Hubtel payouts can be checked: the request is refused." })
  }
  return { summary: "Ask the gateway about a refund payout", lines }
}

async function refundPreviewCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const o = await loadOrder(ctx, str(b.table), str(b.orderId))
  return {
    summary: "Preview a refund (nothing is changed)",
    lines: [
      { label: "Order", value: o ? `${o.packageLabel || "order"} ${o.network} · ${o.table} · ${o.id}` : `${str(b.table)} · ${str(b.orderId)}` },
      { label: "What it does", value: "Works out whether the order can be refunded, the default amount, which refund methods fit, and the shop profit that would be taken back. Nothing is paid or changed." },
    ],
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------------------------------------------------

async function loadWithdrawal(ctx: CardCtx, id: string): Promise<{ row: Obj | null; shop: string }> {
  const row = await readRow(() =>
    ctx.db
      .from("withdrawal_requests")
      .select("id, shop_id, amount, fee_amount, net_amount, status, withdrawal_method, payout_provider, account_details")
      .eq("id", id)
      .maybeSingle(),
  )
  let shop = ""
  if (row?.shop_id) {
    const s = await readRow(() => ctx.db.from("user_shops").select("shop_name").eq("id", row.shop_id as string).maybeSingle())
    shop = str(s?.shop_name)
  }
  return { row, shop }
}

/** The full payout destination saved on the request (a payout destination is never masked on a card). */
function destinationOf(row: Obj | null): string {
  const d = (row?.account_details ?? {}) as Obj
  const method = str(row?.withdrawal_method)
  const name = str(d.account_name)
  if (str(d.phone)) return `MoMo ${str(d.phone)}${d.network ? ` (${str(d.network)})` : ""}${name ? ` · name given: ${name}` : ""}`
  if (str(d.account_number)) return `${method === "bank_transfer" ? "Bank account" : "Account"} ${str(d.account_number)}${name ? ` · ${name}` : ""}`
  return "(no payout destination saved on the request)"
}

function withdrawalHead(w: { row: Obj | null; shop: string }, id: string): CardLine[] {
  if (!w.row) return [{ label: "Withdrawal", value: `${id} (could not be read just now)` }]
  return [
    { label: "Withdrawal", value: `${id} · shop ${w.shop || str(w.row.shop_id)}` },
    { label: "Amount", value: `${ghs(w.row.amount)}${w.row.net_amount != null ? ` (net payout ${ghs(w.row.net_amount)} after a ${ghs(w.row.fee_amount ?? 0)} fee)` : ""}` },
    { label: "Paid to", value: destinationOf(w.row) },
    { label: "Status now", value: str(w.row.status) },
  ]
}

async function withdrawalOtpCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(asBody(i).withdrawalId)
  const w = await loadWithdrawal(ctx, id)
  const lines = withdrawalHead(w, id)
  if (w.row && str(w.row.status) !== "awaiting_transfer_otp") {
    lines.push({ label: "Problem", value: `This withdrawal is not waiting for a code (it is "${str(w.row.status)}"): the request is refused.` })
  }
  lines.push(
    { label: "One-time code", value: "Typed in the secure box on this card; the assistant never sees it" },
    { label: "What it does", value: "Releases the Paystack payout to the account above. Once released the money cannot be pulled back." },
    { label: "If Paystack says paid", value: "The withdrawal becomes completed, the shop balance is recalculated and the shop owner is told their money was sent." },
    { label: "If still pending", value: "It moves to processing and Paystack's confirmation completes it later." },
    { label: "If the code is wrong", value: "Refused; nothing is paid and the status does not change." },
  )
  return { summary: `Release a withdrawal payout of ${w.row ? ghs(w.row.amount) : "money"} with its one-time code`, lines }
}

async function withdrawalResetCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(asBody(i).withdrawalId)
  const w = await loadWithdrawal(ctx, id)
  const lines = withdrawalHead(w, id)
  if (w.row && !["processing", "awaiting_transfer_otp"].includes(str(w.row.status))) {
    lines.push({ label: "Problem", value: `Only processing or awaiting-code withdrawals can be reset (this one is "${str(w.row.status)}"): the request is refused.` })
  }
  lines.push(
    { label: "Status after", value: "pending (back in the approval queue)" },
    { label: "What is cleared", value: "The saved Moolre and Paystack transfer ids, fees and attempt time; the payout rail is set back to Moolre." },
    { label: "Danger", value: "If the money was already sent at Moolre or Paystack, approving it again would pay the shop TWICE. Check the provider's dashboard first." },
    { label: "Not done", value: "No money moves and the shop owner is not told." },
  )
  return { summary: "Reset a stuck withdrawal back to pending", lines }
}

async function withdrawalValidateCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(asBody(i).withdrawalId)
  const w = await loadWithdrawal(ctx, id)
  const lines = withdrawalHead(w, id)
  lines.push({ label: "What it does", value: "Asks Moolre which name is registered on the MoMo number above and compares it with the name the shop gave. Nothing is paid or changed." })
  if (w.row && str(w.row.withdrawal_method) === "bank_transfer") lines.push({ label: "Problem", value: "Not supported for bank transfers: the request is refused." })
  return { summary: "Check the registered name on a withdrawal's MoMo number", lines }
}

async function recalibrateCard(_i: EntryInput, ctx: CardCtx): Promise<Card> {
  const shops = await readCount(() => ctx.db.from("user_shops").select("id", { count: "exact", head: true }))
  return {
    summary: "Recalculate every shop's available balance",
    lines: [
      { label: "Shops checked", value: shops === null ? "all of them" : String(shops) },
      { label: "What it does", value: "Rebuilds each shop's withdrawable balance from its credited profits and withdrawals and overwrites the saved balance wherever it differs. A shop's balance can go up or down at once." },
      { label: "Not done", value: "No money is sent and no shop owner is told. The result lists the shops whose balance changed (before and after)." },
    ],
  }
}

async function balanceCard(provider: "Moolre" | "Paystack"): Promise<Card> {
  return {
    summary: `Check the ${provider} payout balance`,
    lines: [{ label: "What it does", value: `Asks ${provider} how much money is in the account used for payouts. Nothing is paid or changed.` }],
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Cashback config
// ---------------------------------------------------------------------------------------------------------------------

function flatten(prefix: string, v: unknown, out: Map<string, string>): void {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const keys = Object.keys(v as Obj)
    if (keys.length === 0 && prefix) out.set(prefix, "{}")
    for (const k of keys) flatten(prefix ? `${prefix}.${k}` : k, (v as Obj)[k], out)
    return
  }
  out.set(prefix, typeof v === "boolean" ? yn(v) : String(v))
}

const MAX_DIFF_LINES = 40

async function cashbackConfigCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const body = asBody(i)
  const lines: CardLine[] = []
  let current
  try {
    current = await getCashbackConfig(ctx.db)
  } catch {
    current = null
  }
  if (!current) {
    lines.push(
      { label: "Problem", value: "The current cashback settings could not be read just now, so the old values cannot be shown." },
      { label: "Requested", value: JSON.stringify(body) },
    )
    return { summary: "Change the cashback and commission settings", lines }
  }
  const v = validateCashbackPatch(body, current)
  if (!v.ok) {
    lines.push({ label: "Problem", value: `${v.error}. The request is refused.` }, { label: "Requested", value: JSON.stringify(body) })
    return { summary: "Change the cashback and commission settings", lines }
  }
  const before = new Map<string, string>()
  const after = new Map<string, string>()
  flatten("", current, before)
  flatten("", mergeCashbackPatch(current, v.patch), after)
  const changes: CardLine[] = []
  for (const [k, nv] of after) {
    const ov = before.get(k)
    if (ov !== nv) changes.push({ label: k, value: `${ov ?? "(not set)"} -> ${nv}` })
  }
  if (changes.length === 0) lines.push({ label: "Result", value: "Nothing would change: every value sent equals what is saved." })
  else {
    lines.push({ label: "Values changing", value: String(changes.length) })
    lines.push(...changes.slice(0, MAX_DIFF_LINES))
    if (changes.length > MAX_DIFF_LINES) lines.push({ label: "More", value: `and ${changes.length - MAX_DIFF_LINES} more changes not shown` })
  }
  lines.push(
    { label: "Effect", value: "Decides how much cashback customers and dealers get back, what shop owners earn on storefront sales, and the payment fees shown on storefront and bot orders for airtime, bundles and bills. It applies to new orders at once; finished orders are not changed. Shares are percentages, rates are percent commission." },
    { label: "Record", value: "The old and new settings are written to the admin audit log. Nobody is messaged." },
  )
  return { summary: "Change the cashback and commission settings", lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// Send & Claim (MoMo claims)
// ---------------------------------------------------------------------------------------------------------------------

const MOMO_ACTIONS = ["void", "restore", "unflag", "credit", "assign"] as const

async function momoFeeNote(ctx: CardCtx, userId: string): Promise<string> {
  const s = await loadMomoClaimSettings(ctx.db)
  const u = await readRow(() => ctx.db.from("users").select("role").eq("id", userId).maybeSingle())
  const pct = str(u?.role) === "dealer" ? s.feeDealerPercent : s.feeCustomerPercent
  return s.source === "db"
    ? `the claim fee for this account type (${pct}% at the moment) is taken off, and the rest is credited to their wallet`
    : "the claim fee for this account type is taken off, and the rest is credited to their wallet"
}

async function momoClaimCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const action = str(b.action)
  const txid = str(b.transactionId)
  const tx = await readRow(() =>
    ctx.db.from("momo_transactions").select("transaction_id, status, amount, network, session_id, flag_reasons").eq("transaction_id", txid).maybeSingle(),
  )
  const lines: CardLine[] = [
    {
      label: "MoMo payment",
      value: tx
        ? `${txid} · ${tx.amount != null ? ghs(tx.amount) : "amount not read from the SMS"} · ${str(tx.network) || "network unknown"} · status ${str(tx.status)}`
        : `${txid} (no such payment found)`,
    },
  ]
  const reason = str(b.reason).trim()
  const needReason = action === "unflag" || action === "credit" || action === "assign"
  if (needReason && !reason) lines.push({ label: "Problem", value: "A reason is required for this action: the request is refused." })
  if (reason) lines.push({ label: "Reason", value: reason })
  switch (action) {
    case "void":
      if (tx && !["pending", "unparsed"].includes(str(tx.status))) lines.push({ label: "Problem", value: `Only pending or unreadable payments can be voided (this one is "${str(tx.status)}"): the request is refused.` })
      lines.push({ label: "Effect", value: "Marks the payment voided: it can no longer be claimed. No wallet is changed." })
      return { summary: "Void a forwarded MoMo payment", lines }
    case "restore":
      if (tx && str(tx.status) !== "voided") lines.push({ label: "Problem", value: `Only voided payments can be restored (this one is "${str(tx.status)}"): the request is refused.` })
      lines.push({ label: "Effect", value: "Sets the payment back to pending so a customer can claim it again. No wallet is changed yet." })
      return { summary: "Restore a voided MoMo payment", lines }
    case "unflag":
      if (tx && str(tx.status) !== "flagged") lines.push({ label: "Problem", value: `Only flagged payments can be cleared (this one is "${str(tx.status)}"): the request is refused.` })
      lines.push({ label: "Effect", value: "Clears the flag: the payment goes back to pending and the failed-claim count restarts, so a customer can claim it normally. No wallet is changed yet." })
      return { summary: "Clear the flag on a MoMo payment", lines }
    case "credit":
    case "assign": {
      let target = ""
      if (action === "credit") {
        const sid = str(tx?.session_id)
        const sess = sid ? await readRow(() => ctx.db.from("wallet_topup_sessions").select("user_id").eq("id", sid).maybeSingle()) : null
        target = str(sess?.user_id)
        lines.push({
          label: "Credited to",
          value: target ? await who(ctx, target) : "no linked top-up session, so there is nobody to credit: the request is refused",
        })
      } else {
        target = str(b.targetUserId)
        lines.push({ label: "Credited to", value: await who(ctx, target) })
      }
      if (tx && !["pending", "flagged", "unparsed"].includes(str(tx.status))) {
        lines.push({
          label: str(tx.status) === "claimed" ? "Note" : "Problem",
          value: str(tx.status) === "claimed" ? "Already claimed: nothing more is credited." : `Only pending, flagged or unreadable payments can be credited (this one is "${str(tx.status)}"): the request is refused.`,
        })
      }
      const given = num(b.amount)
      const sent = tx?.amount != null ? Number(tx.amount) : null
      if (sent === null) {
        lines.push({ label: "Sent amount", value: given === null ? "not read from the SMS and none given: the request is refused" : `${ghs(given)} (given by you, saved on the payment)` })
      } else {
        lines.push({ label: "Sent amount", value: ghs(sent) })
        if (given !== null && given !== sent) lines.push({ label: "Problem", value: "The amount differs from the SMS amount: the request is refused." })
      }
      lines.push({
        label: "Wallet credit",
        value: target ? `The sent amount is added to that wallet: ${await momoFeeNote(ctx, target)}. The payment becomes claimed.` : "none",
      })
      lines.push(
        { label: "Alert", value: "All admins get an alert that an admin credited a MoMo payment (amount and last 4 digits of its id)." },
        { label: "Record", value: "Your id and the reason are saved on the payment. The customer is not messaged." },
      )
      return { summary: action === "credit" ? "Approve and credit a flagged MoMo payment to the customer" : "Assign a MoMo payment to a customer and credit their wallet", lines }
    }
    default:
      lines.push({ label: "Problem", value: "Unknown action: the request is refused." })
      return { summary: "Change a forwarded MoMo payment", lines }
  }
}

async function momoSessionCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(asBody(i).id)
  const s = await readRow(() =>
    ctx.db.from("wallet_topup_sessions").select("user_id, amount, fee, net_amount, status, expires_at").eq("id", id).maybeSingle(),
  )
  const lines: CardLine[] = [{ label: "Top-up session", value: id }]
  if (s) {
    lines.push(
      { label: "Customer", value: await who(ctx, str(s.user_id)) },
      { label: "Amount", value: `${ghs(s.amount)} (fee ${ghs(s.fee)}, wallet credit ${ghs(s.net_amount)})` },
      { label: "Status now", value: str(s.status) },
    )
    if (str(s.status) !== "pending") lines.push({ label: "Problem", value: "Only a pending session can be expired: the request is refused." })
  } else {
    lines.push({ label: "Problem", value: "No such session was found." })
  }
  lines.push({ label: "Effect", value: "Ends the session now: its payment code stops working, so a payment sent for it can no longer be claimed automatically. No money moves." })
  return { summary: "Force-expire a wallet top-up session", lines }
}

async function momoSettingsCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const cur = await loadMomoClaimSettings(ctx.db)
  const lines: CardLine[] = []
  if (cur.source === "defaults") {
    lines.push({ label: "Problem", value: "The saved settings could not be read, so a save is refused to protect them. Try again shortly." })
  }
  const row = (label: string, was: string, now: unknown) => {
    const nv = typeof now === "boolean" ? yn(now) : String(now)
    lines.push({ label, value: cur.source === "db" ? (was === nv ? `${nv} (unchanged)` : `${was} -> ${nv}`) : nv })
  }
  const accounts = Array.isArray(b.accounts) ? (b.accounts as Obj[]) : []
  const showAccts = (xs: { network?: unknown; number?: unknown }[]) => (xs.length ? xs.map((a) => `${str(a.network)} ${str(a.number)}`).join(", ") : "none")
  row("Send & Claim switched", yn(cur.enabled), b.enabled)
  row("Payment accounts customers send money to", showAccts(cur.accounts), showAccts(accounts))
  row("Account name shown to customers", cur.accountName || "(blank)", str(b.accountName) || "(blank)")
  row("Fee charged to customers", `${cur.feeCustomerPercent}%`, `${b.feeCustomerPercent}%`)
  row("Fee charged to dealers", `${cur.feeDealerPercent}%`, `${b.feeDealerPercent}%`)
  row("Smallest wallet credit", ghs(cur.minNetPesewas / 100), ghs(b.minNet))
  row("Largest amount sent", ghs(cur.maxSentPesewas / 100), ghs(b.maxSent))
  const allow = (xs: unknown) => (Array.isArray(xs) ? xs.map((s) => String(s).trim()).join(", ") : "")
  row("SMS senders trusted", allow(cur.senderAllowlist), allow(b.senderAllowlist))
  row("Transaction-id regression limit", String(cur.regressionThreshold), b.regressionThreshold)
  row("Amount that needs review", ghs(cur.reviewThresholdPesewas / 100), ghs(b.reviewThreshold))
  row("Daily cap per customer", ghs(cur.dailyCapPesewas / 100), ghs(b.dailyCap))
  if (b.firstClaimReview !== undefined) row("Review each customer's first claim", yn(cur.firstClaimReview), b.firstClaimReview)
  else lines.push({ label: "Review each customer's first claim", value: `${yn(cur.firstClaimReview)} (left as it is)` })
  const min = num(b.minNet)
  const max = num(b.maxSent)
  if (min !== null && max !== null && max < min) lines.push({ label: "Problem", value: "The largest amount is below the smallest: the request is refused." })
  if (b.enabled === true && !accounts.some((a) => str(a.network) === "MTN")) {
    lines.push({ label: "Problem", value: "Send & Claim cannot be on without an MTN payment account: the request is refused." })
  }
  lines.push(
    { label: "Effect", value: "These are the accounts customers are told to send money to and the fees and limits on crediting wallets. All are saved at once." },
    { label: "Alert", value: "If the first-claim review switch changes, all admins get an alert." },
  )
  return { summary: "Save the Send & Claim (MoMo top-up) settings", lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// Subscription plans
// ---------------------------------------------------------------------------------------------------------------------

async function planSaveCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const b = asBody(i)
  const id = str(b.id)
  const old = id ? await readRow(() => ctx.db.from("subscription_plans").select("name, price, duration_days, is_active, description").eq("id", id).maybeSingle()) : null
  const lines: CardLine[] = []
  const newActive = b.is_active === undefined ? true : b.is_active === true
  const diff = (was: unknown, now: string) => (old ? `${String(was)} -> ${now}` : now)
  lines.push({ label: "Plan", value: id ? (old ? `editing "${str(old.name)}" (id ${id})` : `id ${id} (no such plan found: the save fails)`) : "a NEW plan" })
  lines.push(
    { label: "Name", value: diff(old?.name, str(b.name)) },
    { label: "Price", value: diff(old?.price != null ? ghs(old.price) : "", ghs(b.price)) },
    { label: "Length", value: diff(old?.duration_days != null ? `${old.duration_days} days` : "", `${b.duration_days} days`) },
    { label: "On sale after", value: diff(old ? (old.is_active ? "yes" : "no") : "", newActive ? "yes" : "no") },
  )
  if (b.is_active === undefined && old && old.is_active === false) {
    lines.push({ label: "Warning", value: "is_active was left out, and a save without it switches the plan ON. Say false to keep it off." })
  }
  if (b.description !== undefined) lines.push({ label: "Description", value: diff(old?.description ?? "", str(b.description)) })
  lines.push({
    label: "Effect",
    value: "Dealers buying this plan from now on pay this price for this many days. Subscriptions already bought keep the amount paid and their end date.",
  })
  return { summary: id ? `Save changes to a subscription plan (${ghs(b.price)})` : `Create a subscription plan (${ghs(b.price)})`, lines }
}

async function planDeleteCard(i: EntryInput, ctx: CardCtx): Promise<Card> {
  const id = str(i.query?.id)
  const plan = await readRow(() => ctx.db.from("subscription_plans").select("name, price, duration_days, is_active").eq("id", id).maybeSingle())
  const subs = await readCount(() => ctx.db.from("user_subscriptions").select("id", { count: "exact", head: true }).eq("plan_id", id))
  const lines: CardLine[] = [
    { label: "Plan", value: plan ? `"${str(plan.name)}" · ${ghs(plan.price)} · ${plan.duration_days} days · ${plan.is_active ? "on sale" : "off sale"} (id ${id})` : `${id} (no such plan found)` },
    { label: "Subscriptions on it", value: subs === null ? "unknown" : String(subs) },
  ]
  if (subs !== null && subs > 0) lines.push({ label: "Warning", value: "Subscriptions already use this plan, so the database is likely to refuse the delete. To stop selling it, save the plan with is_active false instead." })
  lines.push({ label: "Effect", value: "Permanently deletes the plan so dealers can no longer buy it. Nobody is refunded and nobody is messaged." })
  return { summary: "Delete a subscription plan", lines }
}

// ---------------------------------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------------------------------

const refundIdParams = { id: "uuid" } as const
const groupBools = z
  .object({ airtime: z.boolean().optional(), bundles: z.boolean().optional(), bills: z.boolean().optional() })
  .strict()
const feeNum = z.number().min(0).max(MAX_PAYMENT_FEE)
const feeObj = z.object({ airtime: feeNum.optional(), bundles: feeNum.optional(), bills: feeNum.optional() }).strict()
const shareNum = z.number().min(0).max(MAX_SHARE)
const groupShares = z
  .object({ customer: shareNum, dealer: shareNum, storefrontCustomer: shareNum, storefrontShop: shareNum })
  .strict()
const partialShares = z
  .object({ customer: shareNum.optional(), dealer: shareNum.optional(), storefrontCustomer: shareNum.optional(), storefrontShop: shareNum.optional() })
  .strict()

const cashbackBody = z
  .object({
    enabled: z.boolean().optional(),
    surfaces: z
      .object({ dashboard: z.boolean().optional(), bots: z.boolean().optional(), storefront: z.boolean().optional(), api: z.boolean().optional() })
      .strict()
      .optional(),
    rates: z.record(z.string().regex(/^(airtime|data|bill)_[a-z_]+:(hubtel|digiwapy)$/), z.number().min(0).max(MAX_RATE)).optional(),
    shares: z
      .object({
        airtime: groupShares.optional(),
        bundles: groupShares.optional(),
        bills: groupShares.optional(),
        overrides: z.record(z.string().min(1).max(64), partialShares).optional(),
      })
      .strict()
      .optional(),
    paymentFee: feeObj.optional(),
    storefrontGroups: groupBools.optional(),
    botGroups: groupBools.optional(),
    botFees: z.object({ paystack: feeObj.optional(), hubtel: feeObj.optional() }).strict().optional(),
  })
  .strict()

const momoNetwork = z.enum(["MTN", "Telecel", "AirtelTigo"])
const money2 = z.number().min(0).max(1000000)

// ---------------------------------------------------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------------------------------------------------

export const MONEY_ENTRIES: CatalogEntry[] = [
  // ---- refunds: lookups ----
  {
    id: "refunds.pending",
    area: "money",
    ...where("/admin/refunds"),
    summary: "List paid orders that may need a refund, with whether each is eligible and the default refund amount.",
    method: "GET",
    path: "/api/admin/refunds/pending",
    query: z
      .object({
        type: z.enum(ORDER_TABLES as [OrderTable, ...OrderTable[]]).optional(),
        shopId: uuid.optional(),
        q: z.string().max(100).optional(),
        page: pageNo.max(100).optional(),
      })
      .strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    timeoutMs: 60000,
    resultKeep: [
      "page",
      "pageSize",
      "rows[].order.table",
      "rows[].order.id",
      "rows[].order.orderStatus",
      "rows[].order.paymentStatus",
      "rows[].order.shopName",
      "rows[].order.packageLabel",
      "rows[].order.network",
      "rows[].order.paid",
      "rows[].order.createdAt",
      "rows[].eligibility",
      "rows[].manualRefund",
      "rows[].defaultAmount",
    ],
  },
  {
    id: "refunds.history",
    area: "money",
    ...where("/admin/refunds"),
    summary: "List refunds already started, newest first, with their method, amount, destination and status.",
    method: "GET",
    path: "/api/admin/refunds/history",
    query: z
      .object({
        page: pageNo.optional(),
        status: z.enum(["reserved", "processing", "awaiting_otp", "completed", "failed"]).optional(),
      })
      .strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: [
      "page",
      "pageSize",
      "rows[].id",
      "rows[].order_table",
      "rows[].order_id",
      "rows[].gateway",
      "rows[].status",
      "rows[].amount",
      "rows[].destination_phone",
      "rows[].error",
      "rows[].created_at",
      "rows[].completed_at",
    ],
  },
  {
    id: "refunds.wallet_attention",
    area: "money",
    ...where("/admin/refunds"),
    summary: "List wallet payments on the Hubtel main code that need a person to look (review needed, or still debited).",
    method: "GET",
    path: "/api/admin/refunds/wallet-attention",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: [
      "truncated",
      "rows[].paymentId",
      "rows[].orderTable",
      "rows[].orderId",
      "rows[].amount",
      "rows[].state",
      "rows[].kind",
      "rows[].reason",
      "rows[].refundHint",
      "rows[].createdAt",
    ],
  },
  // ---- refunds: reads that ask a gateway ----
  {
    id: "refunds.gateway_status",
    area: "money",
    ...where("/admin/refunds"),
    summary: "Ask Paystack or Hubtel what it says about one refund payout. Nothing is changed.",
    method: "GET",
    path: "/api/admin/refunds/:id/gateway-status",
    params: refundIdParams,
    kind: "change", // calls the gateway
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    card: refundGatewayStatusCard,
  },
  {
    id: "refunds.preview",
    area: "money",
    ...where("/admin/refunds"),
    summary: "Work out whether an order can be refunded, the default amount and which refund methods fit. Nothing is changed.",
    method: "POST",
    path: "/api/admin/refunds/preview",
    body: z.object({ table: z.enum(ORDER_TABLES as [OrderTable, ...OrderTable[]]), orderId: uuid }).strict(),
    kind: "change",
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    card: refundPreviewCard,
  },
  // ---- refunds: money ----
  {
    id: "refunds.execute",
    area: "money",
    ...where("/admin/refunds"),
    summary: "Refund an order: pay the customer back (wallet, Paystack reversal, MoMo payout or by hand), take back the shop's profit and mark the order refunded.",
    method: "POST",
    path: "/api/admin/refunds",
    body: z
      .object({
        table: z.enum(ORDER_TABLES as [OrderTable, ...OrderTable[]]),
        orderId: uuid,
        gateway: z.enum(REFUND_GATEWAYS),
        amount: z.number().positive().max(1000000),
        confirmOverride: z.boolean().optional(),
        manualReference: MANUAL_REF.optional(),
      })
      .strict(),
    kind: "change",
    risk: "money",
    auth: "admin",
    timeoutMs: 60000,
    card: refundExecuteCard,
  },
  {
    id: "refunds.manual",
    area: "money",
    ...where("/admin/refunds"),
    summary: "Record that a storefront or bot airtime, bill or bundle order was refunded by hand. No money moves here.",
    method: "POST",
    path: "/api/admin/refunds/manual",
    body: z
      .object({
        table: z.enum(COMMISSION_TABLES as unknown as [string, ...string[]]),
        orderId: uuid,
        note: z.string().min(1).max(500),
        confirmOverride: z.boolean().optional(),
      })
      .strict(),
    kind: "change",
    risk: "money",
    auth: "admin",
    timeoutMs: 60000,
    card: refundManualCard,
  },
  {
    id: "refunds.retry",
    area: "money",
    ...where("/admin/refunds"),
    summary: "Start a new refund payout for an order whose earlier refund failed, optionally with another method or amount.",
    method: "POST",
    path: "/api/admin/refunds/:id/retry",
    params: refundIdParams,
    body: z
      .object({
        gateway: z.enum(["paystack", "hubtel_send", "paystack_payout", "moolre", "hubtel", "wallet"]).optional(),
        amount: z.number().positive().max(1000000).optional(),
        confirmOverride: z.boolean().optional(),
      })
      .strict(),
    kind: "change",
    risk: "money",
    auth: "admin",
    timeoutMs: 60000,
    card: refundRetryCard,
  },
  {
    id: "refunds.cancel",
    area: "money",
    ...where("/admin/refunds"),
    summary: "Cancel a refund payout that is waiting for its one-time code and restore the shop's profit.",
    method: "POST",
    path: "/api/admin/refunds/:id/cancel",
    params: refundIdParams,
    kind: "change",
    risk: "money",
    auth: "admin",
    timeoutMs: 30000,
    card: refundCancelCard,
  },
  {
    id: "refunds.reconcile",
    area: "money",
    ...where("/admin/refunds"),
    summary: "Re-check an unfinished refund payout with its gateway and complete or fail it on the answer.",
    method: "POST",
    path: "/api/admin/refunds/:id/reconcile",
    params: refundIdParams,
    kind: "change",
    risk: "money",
    auth: "admin",
    timeoutMs: 30000,
    card: refundReconcileCard,
  },
  {
    id: "refunds.otp",
    area: "money",
    ...where("/admin/refunds"),
    summary: "Release a Paystack refund payout with its one-time code. The code is typed into the card's secure box, never into chat.",
    method: "POST",
    path: "/api/admin/refunds/:id/otp",
    params: refundIdParams,
    body: z.object({}).strict(),
    secretFields: [{ name: "otp", label: "Payout one-time code", min: 4, max: 10 }],
    kind: "change",
    risk: "money",
    auth: "admin",
    timeoutMs: 30000,
    card: refundOtpCard,
  },
  {
    id: "refunds.hubtel_never_paid",
    area: "money",
    ...where("/admin/refunds"),
    summary: "Mark a stuck Hubtel refund payout as never paid, after Hubtel confirms it, so the order can be refunded again.",
    method: "POST",
    path: "/api/admin/refunds/:id/hubtel-never-paid",
    params: refundIdParams,
    body: z.object({ confirm: z.literal(true) }).strict(),
    kind: "change",
    risk: "money",
    auth: "admin",
    timeoutMs: 30000,
    card: refundNeverPaidCard,
  },
  // ---- withdrawals ----
  {
    id: "withdrawals.approve",
    area: "money",
    ...where("/admin/withdrawals"),
    summary: "Approve a shop withdrawal and send the payout through Moolre.",
    method: "POST",
    path: "/api/admin/withdrawals/approve",
    body: z.object({ withdrawalId: uuid }).strict(),
    kind: "change",
    risk: "money",
    auth: "admin",
    timeoutMs: 60000,
    typedCard: "prepare_withdrawal_action",
  },
  {
    id: "withdrawals.reject",
    area: "money",
    ...where("/admin/withdrawals"),
    summary: "Reject a shop withdrawal with a reason. The shop owner is told and their balance is restored.",
    method: "POST",
    path: "/api/admin/withdrawals/reject",
    body: z.object({ withdrawalId: uuid, reason: z.string().min(1).max(500).optional() }).strict(),
    kind: "change",
    risk: "money",
    auth: "admin",
    typedCard: "prepare_withdrawal_action",
  },
  {
    id: "withdrawals.complete",
    area: "money",
    ...where("/admin/withdrawals"),
    summary: "Mark an approved withdrawal as paid out. No money is sent here.",
    method: "POST",
    path: "/api/admin/withdrawals/complete",
    body: z.object({ withdrawalId: uuid }).strict(),
    kind: "change",
    risk: "money",
    auth: "admin",
    typedCard: "prepare_withdrawal_action",
  },
  {
    id: "withdrawals.submit_otp",
    area: "money",
    ...where("/admin/withdrawals"),
    summary: "Release a Paystack withdrawal payout with its one-time code. The code is typed into the card's secure box, never into chat.",
    method: "POST",
    path: "/api/admin/withdrawals/submit-transfer-otp",
    body: z.object({ withdrawalId: uuid }).strict(),
    secretFields: [{ name: "otp", label: "Payout one-time code", min: 4, max: 12 }],
    kind: "change",
    risk: "money",
    auth: "admin",
    timeoutMs: 60000,
    card: withdrawalOtpCard,
  },
  {
    id: "withdrawals.reset_processing",
    area: "money",
    ...where("/admin/withdrawals"),
    summary: "Reset a stuck processing or awaiting-code withdrawal back to pending so it can be approved again.",
    method: "POST",
    path: "/api/admin/withdrawals/reset-processing",
    body: z.object({ withdrawalId: uuid }).strict(),
    kind: "change",
    risk: "money",
    auth: "admin",
    card: withdrawalResetCard,
  },
  {
    id: "withdrawals.validate_name",
    area: "money",
    ...where("/admin/withdrawals"),
    summary: "Ask Moolre which name is registered on a withdrawal's MoMo number and compare it with the name given.",
    method: "POST",
    path: "/api/admin/withdrawals/validate-name",
    body: z.object({ withdrawalId: uuid }).strict(),
    kind: "change", // calls the provider
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    card: withdrawalValidateCard,
  },
  {
    id: "withdrawals.recalibrate",
    area: "money",
    ...where("/admin/withdrawal-history"),
    summary: "Recalculate every shop's available balance from its profits and withdrawals and fix any that are wrong.",
    method: "POST",
    path: "/api/admin/withdrawals/recalibrate",
    kind: "change",
    risk: "money",
    auth: "admin",
    timeoutMs: 60000,
    card: recalibrateCard,
  },
  {
    id: "withdrawals.moolre_balance",
    area: "money",
    ...where("/admin/withdrawals"),
    summary: "Check how much money is in the Moolre payout account.",
    method: "GET",
    path: "/api/admin/withdrawals/moolre-balance",
    kind: "change", // calls the provider
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    card: () => balanceCard("Moolre"),
  },
  {
    id: "withdrawals.paystack_balance",
    area: "money",
    ...where("/admin/withdrawals"),
    summary: "Check how much money is in the Paystack payout balance.",
    method: "GET",
    path: "/api/admin/withdrawals/paystack-balance",
    kind: "change", // calls the provider
    risk: "normal",
    auth: "admin",
    timeoutMs: 30000,
    card: () => balanceCard("Paystack"),
  },
  // ---- cashback ----
  {
    id: "cashback.get_config",
    area: "money",
    ...where("/admin/hubtel-commission"),
    summary: "Show the cashback and commission settings: switches, rates, shares and payment fees.",
    method: "GET",
    path: "/api/admin/cashback/config",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: ["config"],
  },
  {
    id: "cashback.report",
    area: "money",
    ...where("/admin/hubtel-commission"),
    summary: "Show the cashback margin report by service and provider for a date range (default the last 7 days).",
    method: "GET",
    path: "/api/admin/cashback/report",
    query: z
      .object({
        from: dateText.optional(),
        to: dateText.optional(),
        channel: z.enum(["all", "dashboard", "storefront", "api", "bots"]).optional(),
      })
      .strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    timeoutMs: 60000,
    resultKeep: [
      "from",
      "to",
      "rows[].service_key",
      "rows[].provider",
      "rows[].orders",
      "rows[].face_total",
      "rows[].actual_commission",
      "rows[].cashback_total",
      "rows[].shop_share_total",
      "rows[].expected_commission",
    ],
  },
  {
    id: "cashback.set_config",
    area: "money",
    ...where("/admin/hubtel-commission"),
    summary: "Change the cashback and commission settings (switches, provider rates, customer, dealer and shop shares, payment fees). Only the keys sent are changed.",
    method: "POST",
    path: "/api/admin/cashback/config",
    body: cashbackBody,
    kind: "change",
    risk: "money",
    auth: "admin",
    card: cashbackConfigCard,
  },
  // ---- profits ----
  {
    id: "profits.history",
    area: "money",
    ...where("/admin/profits-history"),
    summary: "List the profits credited to shops, with their status and the order behind each, plus totals.",
    method: "GET",
    path: "/api/admin/profits-history",
    query: z
      .object({
        page: pageNo.optional(),
        limit: z.number().int().min(1).max(100).optional(),
        status: z.enum(["pending", "credited", "withdrawn"]).optional(),
        startDate: dateText.optional(),
        endDate: dateText.optional(),
        shopId: uuid.optional(),
      })
      .strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    timeoutMs: 60000,
    resultKeep: [
      "stats",
      "pagination.page",
      "pagination.limit",
      "pagination.totalCount",
      "pagination.totalPages",
      "profits[].id",
      "profits[].shop_id",
      "profits[].shop_name",
      "profits[].profit_amount",
      "profits[].status",
      "profits[].credited_at",
      "profits[].created_at",
      "profits[].order_reference",
      "profits[].order_network",
      "profits[].order_total_price",
      "profits[].is_parent_profit",
      "profits[].is_subagent_order",
    ],
  },
  {
    id: "subagent_profits.list",
    area: "money",
    ...where("/admin/sub-agent-profits"),
    summary: "List parent shops with their sub-agents and what each earned from them.",
    method: "GET",
    path: "/api/admin/sub-agent-profits",
    kind: "lookup",
    risk: "normal",
    auth: "other", // own bearer-token check: users.role = 'admin', the same bar as verifyAdminAccess
    timeoutMs: 60000,
    resultKeep: [
      "parentShops[].id",
      "parentShops[].shop_name",
      "parentShops[].is_active",
      "parentShops[].total_sub_agents",
      "parentShops[].total_orders_from_subagents",
      "parentShops[].total_earned_from_subagents",
      "parentShops[].sub_agents[].id",
      "parentShops[].sub_agents[].shop_name",
      "parentShops[].sub_agents[].total_orders",
      "parentShops[].sub_agents[].total_profit_to_parent",
    ],
  },
  {
    id: "subagent_profits.shop",
    area: "money",
    ...where("/admin/sub-agent-profits/:shopId"),
    summary: "Show one parent shop's balance, its sub-agents and the latest profit it earned from their orders.",
    method: "GET",
    path: "/api/admin/sub-agent-profits/:shopId",
    params: { shopId: "uuid" },
    kind: "lookup",
    risk: "normal",
    auth: "other", // own bearer-token check: users.role = 'admin', the same bar as verifyAdminAccess
    timeoutMs: 60000,
    resultKeep: [
      "parent_shop.id",
      "parent_shop.shop_name",
      "parent_shop.is_active",
      "parent_shop.available_balance",
      "parent_shop.total_profit",
      "parent_shop.credited_profit",
      "parent_shop.withdrawn_amount",
      "summary",
      "sub_agents[].id",
      "sub_agents[].shop_name",
      "sub_agents[].total_orders",
      "sub_agents[].total_order_value",
      "sub_agents[].total_profit_to_parent",
      "profit_history[].reference_code",
      "profit_history[].sub_agent_name",
      "profit_history[].order_total",
      "profit_history[].profit_amount",
      "profit_history[].profit_status",
      "profit_history[].created_at",
    ],
  },
  // ---- Send & Claim ----
  {
    id: "momo_claims.list",
    area: "money",
    ...where("/admin/momo-claims"),
    summary: "List forwarded MoMo payments with counts by status, suspicious claimers and the current Send & Claim settings.",
    method: "GET",
    path: "/api/admin/momo-claims",
    query: z
      .object({
        status: z.enum(["pending", "claimed", "flagged", "voided", "unparsed", "rejected_sender"]).optional(),
        network: z.string().max(20).optional(),
        from: dateText.optional(),
        to: dateText.optional(),
        q: z.string().max(60).optional(),
      })
      .strict(),
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: [
      "settingsDefaulted",
      "counts",
      "suspicious[].userId",
      "suspicious[].attempts",
      "settings",
      "transactions[].transaction_id",
      "transactions[].network",
      "transactions[].amount",
      "transactions[].status",
      "transactions[].flag_reasons",
      "transactions[].claimed_by",
      "transactions[].claimed_at",
      "transactions[].fee",
      "transactions[].net_amount",
      "transactions[].credited_by_admin",
      "transactions[].admin_reason",
      "transactions[].received_at",
    ],
  },
  {
    id: "momo_claims.sessions",
    area: "money",
    ...where("/admin/momo-claims"),
    summary: "List the latest wallet top-up payment sessions with their amount, fee and status.",
    method: "GET",
    path: "/api/admin/momo-claims/sessions",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: [
      "sessions[].id",
      "sessions[].userId",
      "sessions[].amount",
      "sessions[].fee",
      "sessions[].netAmount",
      "sessions[].status",
      "sessions[].createdAt",
      "sessions[].expiresAt",
      "sessions[].claimedTransactionId",
    ],
  },
  {
    id: "momo_claims.reconcile_runs",
    area: "money",
    ...where("/admin/momo-claims"),
    summary: "List the last 20 statement reconciliation runs and how many claimed payments were missing from the statement.",
    method: "GET",
    path: "/api/admin/momo-claims/reconcile",
    kind: "lookup",
    risk: "normal",
    auth: "admin",
    resultKeep: [
      "runs[].id",
      "runs[].period_start",
      "runs[].period_end",
      "runs[].statement_txids",
      "runs[].claimed_checked",
      "runs[].missingCount",
      "runs[].created_at",
    ],
  },
  {
    id: "momo_claims.settings_save",
    area: "money",
    ...where("/admin/momo-claims"),
    summary: "Save the whole Send & Claim settings form: the accounts customers pay into, fees, limits and trusted SMS senders. Every field except firstClaimReview must be sent.",
    method: "POST",
    path: "/api/admin/momo-claims",
    body: z
      .object({
        enabled: z.boolean(),
        accounts: z.array(z.object({ network: momoNetwork, number: z.string().regex(/^0[0-9]{9}$/) }).strict()).max(20),
        accountName: z.string().max(80),
        feeCustomerPercent: z.number().min(0).max(100),
        feeDealerPercent: z.number().min(0).max(100),
        minNet: money2,
        maxSent: money2,
        senderAllowlist: z.array(z.string().trim().min(1).max(40)).min(1).max(20),
        regressionThreshold: z.number().int().min(0).max(1000000000),
        reviewThreshold: money2,
        dailyCap: money2,
        firstClaimReview: z.boolean().optional(),
      })
      .strict(),
    kind: "change",
    risk: "money",
    auth: "admin",
    card: momoSettingsCard,
  },
  {
    id: "momo_claims.act",
    area: "money",
    ...where("/admin/momo-claims"),
    summary: "Act on one forwarded MoMo payment: void, restore, clear its flag, approve and credit it to the customer who started it, or assign it to a chosen customer.",
    method: "PATCH",
    path: "/api/admin/momo-claims",
    body: z
      .object({
        action: z.enum(MOMO_ACTIONS),
        transactionId: z.string().min(1).max(60),
        reason: reason200.optional(),
        targetUserId: uuid.optional(),
        amount: z.number().positive().lt(1000000).optional(),
      })
      .strict(),
    kind: "change",
    risk: "money",
    auth: "admin",
    card: momoClaimCard,
  },
  {
    id: "momo_claims.expire_session",
    area: "money",
    ...where("/admin/momo-claims"),
    summary: "Force-expire a pending wallet top-up session so its payment code stops working.",
    method: "PATCH",
    path: "/api/admin/momo-claims/sessions",
    body: z.object({ action: z.literal("force_expire"), id: uuid }).strict(),
    kind: "change",
    risk: "money",
    auth: "admin",
    card: momoSessionCard,
  },
  // ---- subscriptions ----
  {
    id: "subscriptions.list",
    area: "money",
    ...where("/admin/subscribers"),
    summary: "List every dealer subscription with its plan, dates, status and what was paid.",
    method: "GET",
    path: "/api/admin/subscriptions",
    kind: "lookup",
    risk: "normal",
    auth: "other", // own bearer-token check: users.role = 'admin', the same bar as verifyAdminAccess
    resultKeep: [
      "subscriptions[].id",
      "subscriptions[].user_id",
      "subscriptions[].status",
      "subscriptions[].start_date",
      "subscriptions[].end_date",
      "subscriptions[].amount_paid",
      "subscriptions[].plan.name",
      "subscriptions[].plan.duration_days",
      "subscriptions[].user.first_name",
      "subscriptions[].user.last_name",
    ],
  },
  {
    id: "subscription_plans.list",
    area: "money",
    ...where("/admin/subscriptions"),
    summary: "List the subscription plans dealers can buy, with price, length and whether each is on sale.",
    method: "GET",
    path: "/api/admin/subscription-plans",
    kind: "lookup",
    risk: "normal",
    auth: "other", // admin-aware: the full list (including plans not on sale) only for a bearer token of an admin
    resultKeep: [
      "plans[].id",
      "plans[].name",
      "plans[].description",
      "plans[].price",
      "plans[].duration_days",
      "plans[].is_active",
    ],
  },
  {
    id: "subscription_plans.save",
    area: "money",
    ...where("/admin/subscriptions"),
    summary: "Create a subscription plan, or edit one when its id is given. Price and length are required; a save without is_active puts the plan on sale.",
    method: "POST",
    path: "/api/admin/subscription-plans",
    body: z
      .object({
        id: uuid.optional(),
        name: z.string().min(1).max(100),
        description: z.string().max(500).optional(),
        price: z.number().positive().max(100000),
        duration_days: z.number().int().positive().max(3650),
        is_active: z.boolean().optional(),
      })
      .strict(),
    kind: "change",
    risk: "money",
    auth: "other", // own bearer-token check: users.role = 'admin', the same bar as verifyAdminAccess
    card: planSaveCard,
  },
  {
    id: "subscription_plans.delete",
    area: "money",
    ...where("/admin/subscriptions"),
    summary: "Permanently delete a subscription plan.",
    method: "DELETE",
    path: "/api/admin/subscription-plans",
    query: z.object({ id: uuid }).strict(),
    kind: "change",
    risk: "money",
    auth: "other", // own bearer-token check: users.role = 'admin', the same bar as verifyAdminAccess
    card: planDeleteCard,
  },
]
