import type { SupabaseClient } from "@supabase/supabase-js"
import { refundableStatuses } from "./eligibility"
import { loadPayerPhones } from "./payer-phone"
import { BULK_PROOF_WINDOW_MS, proveBulkBatchPayment } from "./bulk-batch-proof"
import { BILLERS, isBillerKey } from "@/lib/bills/billers"
import { normalizeGhanaPhone } from "@/lib/phone-format"
import {
  isCommissionTable, isWalletOnlyTable, type CommissionLedgerFact, type CommissionTable, type DispatchOutcome,
  type OrderTable, type OwnerCut, type PaymentSource, type RefundableOrder,
} from "./types"

type ClassicTable = Exclude<OrderTable, CommissionTable>

const CHUNK = 100
// orders / api_orders have no shop_profits FK columns (no owners, no clawback).
// Commission tables: the shop's cashback share (airtime: merchant_commission row) is linked by these columns.
const PROFIT_FK: Record<OrderTable, string | null> = {
  shop_orders: "shop_order_id",
  ussd_orders: "ussd_order_id",
  ussd_shop_orders: "ussd_shop_order_id",
  orders: null,
  api_orders: null,
  airtime_orders: "airtime_order_id",
  hubtel_bill_orders: "bill_order_id",
  hubtel_data_orders: "data_order_id",
}
// Debit sources that prove a wallet payment of ONE specific order (a 'bulk_order' batch debit does not reference order ids; it is matched separately by batch reconstruction).
const WALLET_DEBIT_SOURCES = ["data_purchase", "api_order"]
const TRACKING_COL: Record<ClassicTable, string> = {
  shop_orders: "shop_order_id",
  ussd_orders: "order_id",
  ussd_shop_orders: "order_id",
  orders: "order_id",
  api_orders: "api_order_id",
}
// Phone columns searched by the pending list.
const SEARCH_COLS: Record<OrderTable, string[]> = {
  shop_orders: ["customer_phone"],
  ussd_orders: ["dialing_phone", "recipient_phone"],
  ussd_shop_orders: ["dialing_phone", "recipient_phone"],
  orders: ["phone_number"],
  api_orders: ["recipient_phone"],
  airtime_orders: ["beneficiary_phone", "reference_code"],
  hubtel_bill_orders: ["buyer_phone", "account_number", "reference_code"],
  hubtel_data_orders: ["buyer_phone", "beneficiary_phone", "reference_code"],
}

/** orders.created_at is timestamp WITHOUT time zone, stored in UTC: PostgREST returns it with no offset, so mark it UTC. */
const toUtcIso = (v: unknown, naive: boolean): string => {
  const s = String(v ?? "")
  if (!naive || !s || /(Z|[+-]\d\d(:?\d\d)?)$/i.test(s)) return s
  return s.replace(" ", "T") + "Z"
}
const cmpNewestFirst = (a: string, b: string): number => {
  const ta = Date.parse(a), tb = Date.parse(b)
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta
  return a === b ? 0 : a < b ? 1 : -1
}

const SELECT: Record<OrderTable, string> = {
  shop_orders:
    "id, shop_id, customer_phone, customer_email, network, volume_gb, total_price, order_status, payment_status, external_order_id, created_at",
  ussd_orders:
    "id, dialing_phone, recipient_phone, network, package_size, amount, order_status, payment_status, paystack_reference, created_at",
  ussd_shop_orders:
    "id, shop_id, dialing_phone, recipient_phone, network, package_size, amount, order_status, payment_status, paystack_reference, created_at",
  // orders.external_order_id: added by migrations/fix_external_order_id_types.sql. api_orders has no such column in the repo (provider_reference only), so it is NOT selected.
  orders: "id, user_id, network, size, price, status, phone_number, external_order_id, created_at",
  api_orders: "id, user_id, network, volume_gb, price, status, recipient_phone, created_at",
  // Commission tables (storefront rows only; see isStorefrontRow). Paid = total_paid / paid_amount (what the customer paid).
  airtime_orders:
    "id, shop_id, user_id, channel, dialing_phone, network, beneficiary_phone, airtime_amount, total_paid, status, payment_status, notes, created_at, updated_at",
  hubtel_bill_orders:
    "id, shop_id, user_id, channel, biller, account_number, amount, paid_amount, status, payment_status, hubtel_client_reference, notes, buyer_phone, payment_reference, created_at, updated_at",
  hubtel_data_orders:
    "id, shop_id, user_id, channel, network, bundle_display, beneficiary_phone, amount, paid_amount, status, payment_status, hubtel_client_reference, notes, buyer_phone, payment_reference, created_at, updated_at",
}

/**
 * Storefront commission rows: the only ones the refund RPCs accept (BAD_CHANNEL otherwise). Airtime storefront rows are
 * the web storefront's (shop_id, no account, no channel tag, no dialing phone); USSD/WhatsApp shop airtime carries a
 * channel and/or dialing phone and keeps its own path.
 */
export function isStorefrontRow(table: CommissionTable, r: { shop_id?: unknown; user_id?: unknown; channel?: unknown; dialing_phone?: unknown }): boolean {
  if (table === "airtime_orders") return !!r.shop_id && !r.user_id && r.channel == null && !r.dialing_phone
  return r.channel === "storefront"
}

const round2 = (n: number) => Math.round(n * 100) / 100

const chunk = <T,>(arr: T[], n = CHUNK): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

async function inRows<T>(db: SupabaseClient, table: string, select: string, col: string, ids: string[], extra?: (q: any) => any): Promise<T[]> {
  const out: T[] = []
  for (const part of chunk(ids, table === "mtn_fulfillment_tracking" ? 50 : CHUNK)) {
    let q: any = db.from(table).select(select).in(col, part)
    if (extra) q = extra(q)
    const { data, error } = await q
    if (error) throw new Error(`[REFUND] ${table} lookup failed: ${error.message}`)
    // PostgREST silently truncates at 1000 rows; refuse rather than hide evidence.
    if ((data ?? []).length >= 1000) throw new Error(`[REFUND] ${table} lookup hit the 1000-row cap; refusing to proceed on possibly truncated data`)
    out.push(...((data ?? []) as T[]))
  }
  return out
}

export async function resolveWalletUser(
  db: SupabaseClient,
  who: { phone?: string | null; email?: string | null }
): Promise<string | null> {
  if (who.phone) {
    const d = who.phone.replace(/\D/g, "").slice(-9)
    if (d.length === 9) {
      // Phone-verified accounts only (an unverified account can claim any number), and an ambiguous
      // number (2+ accounts) is never a refund target. A real query error still throws.
      const { data, error } = await db.from("users").select("id").eq("phone_number", "0" + d).eq("phone_verified", true).limit(2)
      if (error) throw new Error(`[REFUND] users lookup failed: ${error.message}`)
      if ((data ?? []).length > 1) return null
      if (data?.[0]?.id) return data[0].id as string
    }
  }
  if (who.email) {
    const { data, error } = await db.from("users").select("id").eq("email", who.email.toLowerCase()).limit(2)
    if (error) throw new Error(`[REFUND] users lookup failed: ${error.message}`)
    if ((data ?? []).length > 1) return null
    if (data?.[0]?.id) return data[0].id as string
  }
  return null
}

export async function loadRefundableOrders(
  db: SupabaseClient,
  refs: { table: OrderTable; id: string }[]
): Promise<RefundableOrder[]> {
  const out: RefundableOrder[] = []
  for (const table of Object.keys(SELECT) as OrderTable[]) {
    const ids = refs.filter((r) => r.table === table).map((r) => r.id)
    if (ids.length === 0) continue
    const rows = await inRows<any>(db, table, SELECT[table], "id", ids)
    out.push(...(isCommissionTable(table) ? await enrichCommission(db, table, rows) : await enrich(db, table, rows)))
  }
  return out
}

/** Per-shop credited/pending profit for one order, with each owner's balances (pesewa-exact sums). */
function ownersOf(
  orderProfits: any[], shopById: Map<string, any>, balanceByShop: Map<string, number>, walletByUser: Map<string, number>,
): OwnerCut[] {
  const byShop = new Map<string, { credited: number; pending: number }>()
  for (const p of orderProfits) {
    const cur = byShop.get(p.shop_id) ?? { credited: 0, pending: 0 } // integer pesewas
    const pesewas = Math.round(Number(p.profit_amount) * 100)
    if (p.status === "credited") cur.credited += pesewas
    else if (p.status === "pending") cur.pending += pesewas
    byShop.set(p.shop_id, cur)
  }
  return [...byShop.entries()]
    .filter(([, v]) => v.credited !== 0 || v.pending !== 0)
    .map(([shopId, v]) => {
      const ownerUserId = (shopById.get(shopId)?.user_id as string | undefined) ?? null
      return {
        shopId, ownerUserId, credited: v.credited / 100, pending: v.pending / 100,
        availableBalance: balanceByShop.get(shopId) ?? 0,
        walletBalance: ownerUserId ? walletByUser.get(ownerUserId) ?? 0 : 0,
      }
    })
}

const billLabel = (biller: unknown) => (isBillerKey(biller) ? BILLERS[biller].label : String(biller ?? "Bill"))

/**
 * Storefront commission orders (airtime / bills / bundles). Paid by an anonymous storefront buyer through Paystack:
 * - paid = total_paid (airtime) / paid_amount (bills, bundles; face amount on legacy rows) — exactly what the RPC gets;
 * - Paystack reference = the row's payment_reference (bills/bundles, set at the guarded paid flip) or the completed
 *   wallet_payments row for the order (airtime);
 * - payer number = the recorded direct-charge payer (payment_attempts.payer_phone), else the buyer's phone
 *   (bills/bundles buyer_phone). Airtime has no buyer phone column; its beneficiary is a recipient, never the payer;
 * - no wallet (walletUserId null): the buyer has no account;
 * - Hubtel ledger rows feed eligibility (never refund while Hubtel may still deliver).
 */
async function enrichCommission(db: SupabaseClient, table: CommissionTable, rows: any[]): Promise<RefundableOrder[]> {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id as string)
  const fk = PROFIT_FK[table]!

  const [profits, refunds, walletPayments, ledgerRows] = await Promise.all([
    inRows<any>(db, "shop_profits", `shop_id, profit_amount, status, ${fk}`, fk, ids, (q) => q.is("refund_id", null)),
    inRows<any>(db, "order_refunds", "order_id, status", "order_id", ids, (q) => q.neq("status", "failed")),
    inRows<any>(db, "wallet_payments", "order_id, reference, amount, fee, status", "order_id", ids),
    inRows<any>(db, "hubtel_cs_transactions", "order_id, client_reference, state, refund_claimed_at, resolved_by, created_at", "order_id", ids,
      (q) => q.eq("order_table", table)),
  ])

  const shopIds = [...new Set([
    ...profits.map((p) => p.shop_id as string),
    ...rows.map((r) => r.shop_id as string | undefined).filter(Boolean) as string[],
  ])]
  const [shops, balances] = await Promise.all([
    shopIds.length ? inRows<any>(db, "user_shops", "id, shop_name, user_id", "id", shopIds) : Promise.resolve([] as any[]),
    shopIds.length ? inRows<any>(db, "shop_available_balance", "shop_id, available_balance", "shop_id", shopIds) : Promise.resolve([] as any[]),
  ])
  const ownerIds = [...new Set(shops.map((s) => s.user_id as string).filter(Boolean))]
  const wallets = ownerIds.length ? await inRows<any>(db, "wallets", "user_id, balance", "user_id", ownerIds) : []
  const shopById = new Map(shops.map((s) => [s.id as string, s]))
  const balanceByShop = new Map(balances.map((b) => [b.shop_id as string, Number(b.available_balance)]))
  const walletByUser = new Map(wallets.map((w) => [w.user_id as string, Number(w.balance)]))

  const referenceOf = (r: any): string | null => {
    if (table !== "airtime_orders" && r.payment_reference) return String(r.payment_reference)
    const wp = walletPayments.find((w) => w.order_id === r.id && w.status === "completed")
    return (wp?.reference as string | undefined) ?? null
  }
  const refs = rows.map(referenceOf).filter(Boolean) as string[]
  const payerByRef = refs.length ? await loadPayerPhones(db, refs) : new Map<string, string>()

  return rows.map((r) => {
    const id = r.id as string
    const reference = referenceOf(r)
    const wp = reference ? walletPayments.find((w) => w.reference === reference) : undefined
    const buyerPhone = table === "airtime_orders" || !r.buyer_phone ? null : normalizeGhanaPhone(String(r.buyer_phone))
    const payment: PaymentSource = {
      gateway: reference ? "paystack" : null,
      reference,
      payerPhone: (reference ? payerByRef.get(reference) : undefined) ?? buyerPhone ?? null,
      walletUserId: null,
    }
    const paid = round2(Number(table === "airtime_orders" ? r.total_paid : (r.paid_amount ?? r.amount)))
    const ledger: CommissionLedgerFact[] = ledgerRows
      .filter((l) => l.order_id === id)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .map((l) => ({ client_reference: l.client_reference, state: l.state, refund_claimed_at: l.refund_claimed_at ?? null, resolved_by: l.resolved_by ?? null, created_at: l.created_at }))
    const label = table === "airtime_orders"
      ? { packageLabel: `GHS ${Number(r.airtime_amount).toFixed(2)} airtime`, network: String(r.network ?? ""), recipient: r.beneficiary_phone ?? null }
      : table === "hubtel_bill_orders"
        ? { packageLabel: `${billLabel(r.biller)} bill`, network: `(${r.account_number})`, recipient: r.buyer_phone ?? null }
        : { packageLabel: String(r.bundle_display ?? ""), network: String(r.network ?? ""), recipient: r.beneficiary_phone ?? null }
    return {
      table, id,
      orderStatus: r.status as string,
      // bills/bundles say 'paid'; the refund ledger (like reserve_order_refund) speaks 'completed'
      paymentStatus: r.payment_status === "paid" ? "completed" : (r.payment_status as string),
      shopId: (r.shop_id as string | undefined) ?? null,
      shopName: r.shop_id ? (shopById.get(r.shop_id)?.shop_name as string | undefined) ?? null : null,
      packageLabel: label.packageLabel,
      network: label.network,
      recipientPhone: label.recipient as string | null,
      createdAt: toUtcIso(r.created_at, false),
      paid,
      gatewayFee: Number(wp?.fee ?? 0) || 0,
      payment,
      owners: ownersOf(profits.filter((p) => p[fk] === id), shopById, balanceByShop, walletByUser),
      evidence: {
        hasActiveRefund: refunds.some((x) => x.order_id === id),
        dispatchOutcome: null,
        dispatchAttempts: null,
        trackingStatuses: [],
        externalOrderId: null,
        commission: {
          storefront: isStorefrontRow(table, r),
          status: r.status as string,
          paymentStatus: r.payment_status as string,
          hubtelClientReference: (r.hubtel_client_reference as string | null | undefined) ?? null,
          notes: (r.notes as string | null | undefined) ?? null,
          updatedAt: String(r.updated_at ?? r.created_at ?? ""),
          ledger,
        },
      },
    }
  })
}

/**
 * Ids of `orders` rows proven wallet-paid by batch reconstruction. ONE batched lookup per page (siblings + candidate
 * bulk debits). This proof is optional: any lookup failure degrades to "unproven" (no gateway) and is logged, never thrown.
 */
async function loadBulkBatchProven(db: SupabaseClient, candidates: any[]): Promise<Set<string>> {
  const proven = new Set<string>()
  if (candidates.length === 0) return proven
  try {
    const userIds = [...new Set(candidates.map((r) => r.user_id as string).filter(Boolean))]
    const stamps = [...new Set(candidates.map((r) => String(r.created_at ?? "")).filter(Boolean))]
    if (userIds.length === 0 || stamps.length === 0) return proven

    const siblings: any[] = []
    for (const us of chunk(userIds)) {
      for (const ts of chunk(stamps)) {
        siblings.push(...(await inRows<any>(db, "orders", "id, user_id, price, created_at", "user_id", us, (q) => q.in("created_at", ts))))
      }
    }
    const ms = candidates.map((r) => Date.parse(toUtcIso(r.created_at, true))).filter(Number.isFinite)
    if (ms.length === 0) return proven
    const lo = new Date(Math.min(...ms) - BULK_PROOF_WINDOW_MS).toISOString()
    const hi = new Date(Math.max(...ms) + BULK_PROOF_WINDOW_MS).toISOString()
    const debits: any[] = []
    for (const us of chunk(userIds)) {
      debits.push(...(await inRows<any>(db, "transactions", "user_id, amount, created_at, type, source", "user_id", us,
        (q) => q.eq("type", "debit").eq("source", "bulk_order").gte("created_at", lo).lte("created_at", hi))))
    }
    const bulkDebits = debits.filter((t) => t.type === "debit" && t.source === "bulk_order")
    for (const r of candidates) {
      if (proveBulkBatchPayment({ user_id: r.user_id, created_at: String(r.created_at), price: r.price }, siblings, bulkDebits)) proven.add(r.id as string)
    }
  } catch (e) {
    console.error("[REFUND] bulk batch proof lookup failed; treating batch orders as unproven:", e instanceof Error ? e.message : e)
    return new Set<string>()
  }
  return proven
}

async function enrich(db: SupabaseClient, table: ClassicTable, rows: any[]): Promise<RefundableOrder[]> {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id as string)
  const walletOnly = isWalletOnlyTable(table)
  const fk = PROFIT_FK[table]

  const [profits, tracking, claims, refunds, walletDebits, walletPayments, fulfillmentLogs] = await Promise.all([
    fk ? inRows<any>(db, "shop_profits", `shop_id, profit_amount, status, ${fk}`, fk, ids, (q) => q.is("refund_id", null)) : Promise.resolve([] as any[]),
    inRows<any>(db, "mtn_fulfillment_tracking", `status, ${TRACKING_COL[table]}`, TRACKING_COL[table], ids),
    inRows<any>(db, "order_dispatch_claims", "order_id, last_outcome, attempts", "order_id", ids),
    inRows<any>(db, "order_refunds", "order_id, status", "order_id", ids, (q) => q.neq("status", "failed")),
    inRows<any>(db, "transactions", walletOnly ? "reference_id, user_id, type, amount, source" : "reference_id, user_id, type, amount", "reference_id", ids, (q) => (walletOnly ? q.eq("type", "debit").in("source", WALLET_DEBIT_SOURCES) : q.eq("type", "debit"))),
    table === "shop_orders" ? inRows<any>(db, "wallet_payments", "order_id, reference, amount, fee, status", "order_id", ids) : Promise.resolve([] as any[]),
    // CodeCraft (AT-iShare/Telecel/BigTime) logs its dispatch here, not in mtn_fulfillment_tracking. For api orders the
    // log also carries order_id = the api order id (legacy column), so one lookup by order_id covers both tables.
    walletOnly ? inRows<any>(db, "fulfillment_logs", "order_id, status", "order_id", ids) : Promise.resolve([] as any[]),
  ])

  const shopIds = [...new Set([
    ...profits.map((p) => p.shop_id as string),
    ...rows.map((r) => r.shop_id as string | undefined).filter(Boolean) as string[],
  ])]
  const [shops, balances] = await Promise.all([
    shopIds.length ? inRows<any>(db, "user_shops", "id, shop_name, user_id", "id", shopIds) : Promise.resolve([] as any[]),
    shopIds.length ? inRows<any>(db, "shop_available_balance", "shop_id, available_balance", "shop_id", shopIds) : Promise.resolve([] as any[]),
  ])
  const ownerIds = [...new Set(shops.map((s) => s.user_id as string).filter(Boolean))]
  const wallets = ownerIds.length ? await inRows<any>(db, "wallets", "user_id, balance", "user_id", ownerIds) : []

  const paymentRefs = [
    ...walletPayments.map((w) => w.reference as string),
    ...rows.map((r) => (table === "shop_orders" || walletOnly ? null : (r.paystack_reference ?? r.id)) as string | null).filter(Boolean) as string[],
  ]
  const attempts = paymentRefs.length ? await inRows<any>(db, "payment_attempts", "reference, fee", "reference", paymentRefs) : []
  // Payer MoMo number (storefront direct-charge only), in its own query so a missing column cannot break the load.
  const payerByRef = table === "shop_orders" && walletPayments.length
    ? await loadPayerPhones(db, walletPayments.map((w) => w.reference as string))
    : new Map<string, string>()

  const shopById = new Map(shops.map((s) => [s.id as string, s]))
  const balanceByShop = new Map(balances.map((b) => [b.shop_id as string, Number(b.available_balance)]))
  const walletByUser = new Map(wallets.map((w) => [w.user_id as string, Number(w.balance)]))
  const feeByRef = new Map(attempts.map((a) => [a.reference as string, Number(a.fee ?? 0)]))

  // Batch reconstruction (orders only): rows with no qualifying per-order debit may still be proven via the bulk batch debit.
  const bulkProven = table === "orders"
    ? await loadBulkBatchProven(db, rows.filter((r) => {
        const paid = Math.round(Number(r.price) * 100) / 100
        const m = walletDebits.filter((t) => t.reference_id === r.id && Math.abs(Number(t.amount) - paid) < 0.01)
        return !(m.length === 1 && m[0].user_id === r.user_id)
      }))
    : new Set<string>()

  const result: RefundableOrder[] = []
  for (const r of rows) {
    const id = r.id as string
    const orderProfits = fk ? profits.filter((p) => p[fk] === id) : []
    const byShop = new Map<string, { credited: number; pending: number }>()
    for (const p of orderProfits) {
      const cur = byShop.get(p.shop_id) ?? { credited: 0, pending: 0 } // integer pesewas
      const pesewas = Math.round(Number(p.profit_amount) * 100)
      if (p.status === "credited") cur.credited += pesewas
      else if (p.status === "pending") cur.pending += pesewas
      byShop.set(p.shop_id, cur)
    }
    const owners: OwnerCut[] = [...byShop.entries()]
      .filter(([, v]) => v.credited !== 0 || v.pending !== 0)
      .map(([shopId, v]) => {
        const ownerUserId = (shopById.get(shopId)?.user_id as string | undefined) ?? null
        return {
          shopId, ownerUserId, credited: v.credited / 100, pending: v.pending / 100,
          availableBalance: balanceByShop.get(shopId) ?? 0,
          walletBalance: ownerUserId ? walletByUser.get(ownerUserId) ?? 0 : 0,
        }
      })

    // A wallet debit is only proof of wallet payment when its amount matches what the order cost and it is the
    // ONLY such debit: /api/wallet/debit takes a client-supplied orderId, so any user could otherwise attach a
    // token debit to someone else's order and become the refund target.
    const qualifyingDebit = (paidAmount: number) => {
      const matches = walletDebits.filter((t) => t.reference_id === id && Math.abs(Number(t.amount) - paidAmount) < 0.01)
      return matches.length === 1 ? matches[0] : undefined
    }
    let payment: PaymentSource
    let paid: number
    let fee = 0
    if (walletOnly) {
      // Paid from the buyer's wallet at purchase. Proof of WHO paid = exactly one per-order debit (source
      // data_purchase / api_order, reference_id = this order, amount = price) on the order's own user. A bulk-upload
      // order (orders only) is instead proven by batch reconstruction (see bulk-batch-proof.ts); unprovable => no gateway.
      paid = Math.round(Number(r.price) * 100) / 100
      const debit = qualifyingDebit(paid)
      payment = (debit && debit.user_id === r.user_id) || bulkProven.has(id)
        ? { gateway: "wallet", reference: null, payerPhone: null, walletUserId: r.user_id as string }
        : { gateway: null, reference: null, payerPhone: null, walletUserId: null }
    } else if (table === "shop_orders") {
      // customer_phone is the data RECIPIENT and is NEVER used as the payer. payerPhone comes only from
      // payment_attempts.payer_phone (recorded at direct MoMo charge time); otherwise null (payout gateways
      // refuse; Paystack reversal / wallet still work).
      // wallet_payments.amount is the TOTAL charged (order price + fee); .fee is the fee part.
      const wp = walletPayments.find((w) => w.order_id === id && w.status === "completed")
      if (wp) {
        paid = Number(wp.amount)
        const debit = qualifyingDebit(paid)
        fee = Number(wp.fee ?? feeByRef.get(wp.reference) ?? 0)
        payment = {
          gateway: "paystack",
          reference: wp.reference ?? null,
          payerPhone: (wp.reference ? payerByRef.get(wp.reference as string) : undefined) ?? null,
          walletUserId: debit?.user_id ?? null, // only a proving wallet debit; never buyer-typed phone/email
        }
      } else {
        paid = Number(r.total_price)
        const debit = qualifyingDebit(paid)
        payment = debit
          ? { gateway: "wallet", reference: null, payerPhone: null, walletUserId: debit.user_id }
          : {
              gateway: null,
              reference: null,
              payerPhone: null,
              walletUserId: null,
            }
      }
    } else {
      paid = Number(r.amount)
      const reference = (r.paystack_reference as string | null) ?? null
      fee = reference ? feeByRef.get(reference) ?? 0 : 0
      const debit = qualifyingDebit(paid)
      if (debit && !reference) {
        payment = { gateway: "wallet", reference: null, payerPhone: r.dialing_phone, walletUserId: debit.user_id }
      } else {
        // A Paystack-referenced order stays 'paystack' even if a (qualifying) debit exists: a debit never reclassifies it.
        payment = {
          gateway: reference ? "paystack" : null,
          reference,
          payerPhone: r.dialing_phone ?? null,
          walletUserId: await resolveWalletUser(db, { phone: r.dialing_phone }),
        }
      }
    }
    if (payment.gateway === "wallet") fee = 0

    const claim = claims.find((c) => c.order_id === id)
    const trackingStatuses = tracking.filter((t) => t[TRACKING_COL[table]] === id).map((t) => t.status as string)
    for (const l of fulfillmentLogs.filter((x) => x.order_id === id)) {
      // success => completed (delivered); failed => failed; pending/processing/anything else => pending (a retry may be queued).
      trackingStatuses.push(l.status === "success" ? "completed" : l.status === "failed" ? "failed" : "pending")
    }
    result.push({
      table, id,
      orderStatus: (walletOnly ? r.status : r.order_status) as string,
      paymentStatus: walletOnly ? "completed" : r.payment_status, // wallet orders were paid at purchase
      buyerUserId: walletOnly ? ((r.user_id as string | undefined) ?? null) : undefined,
      shopId: (r.shop_id as string | undefined) ?? null,
      shopName: r.shop_id ? (shopById.get(r.shop_id)?.shop_name as string | undefined) ?? null : null,
      packageLabel: table === "shop_orders" || table === "api_orders" ? `${r.volume_gb}GB` : String(r.package_size ?? r.size ?? ""),
      network: r.network,
      recipientPhone: (r.recipient_phone ?? r.customer_phone ?? r.phone_number ?? null) as string | null,
      createdAt: toUtcIso(r.created_at, table === "orders"),
      paid, gatewayFee: fee, payment, owners,
      evidence: {
        hasActiveRefund: refunds.some((x) => x.order_id === id),
        dispatchOutcome: (claim?.last_outcome as DispatchOutcome | undefined) ?? null,
        dispatchAttempts: claim ? Number(claim.attempts ?? 0) : null,
        trackingStatuses,
        externalOrderId: (r.external_order_id as string | null | undefined) != null ? String(r.external_order_id) : null,
      },
    })
  }
  return result
}

export interface PendingQuery {
  table?: OrderTable
  shopId?: string
  q?: string
  pageSize: number
  page: number
}

/**
 * Paid storefront commission orders that may need a refund: pending/failed, plus (bills/bundles) a possibly stuck
 * Hubtel dispatch claim — the same set the bills admin "refund" view lists. Storefront rows only.
 */
function commissionPendingQuery(db: SupabaseClient, table: CommissionTable): any {
  const q: any = db.from(table).select("id, created_at")
  if (table === "airtime_orders") {
    return q.not("shop_id", "is", null).is("user_id", null).is("channel", null).is("dialing_phone", null)
      .eq("payment_status", "completed").in("status", ["pending", "failed"])
  }
  return q.eq("channel", "storefront").eq("payment_status", "paid")
    .or("status.in.(failed,pending),and(status.eq.processing,notes.ilike.Dispatching%,hubtel_client_reference.is.null)")
}

/** Newest-first merged page of paid+pending orders. Each table's top (page*pageSize) rows contain the global top. */
export async function listPendingOrderRefs(db: SupabaseClient, opts: PendingQuery): Promise<{ table: OrderTable; id: string; createdAt: string }[]> {
  const tables = (opts.table ? [opts.table] : (Object.keys(SELECT) as OrderTable[])).filter((t) => !(opts.shopId && (t === "ussd_orders" || isWalletOnlyTable(t)))) // these have no shop_id: never return them unscoped
  const need = opts.pageSize * opts.page
  const all: { table: OrderTable; id: string; createdAt: string }[] = []
  for (const table of tables) {
    let q: any = isWalletOnlyTable(table)
      ? db.from(table).select("id, created_at").in("status", [...refundableStatuses(table)])
      : isCommissionTable(table)
        ? commissionPendingQuery(db, table)
        : db.from(table).select("id, created_at").eq("order_status", "pending").eq("payment_status", "completed")
    if (opts.shopId) q = q.eq("shop_id", opts.shopId)
    if (opts.q) {
      const term = opts.q.replace(/[^0-9a-zA-Z-]/g, "")
      if (term) {
        const cols = SEARCH_COLS[table]
        q = q.or(cols.map((c) => `${c}.ilike.%${term}%`).join(",") + (/^[0-9a-f-]{36}$/i.test(term) ? `,id.eq.${term}` : ""))
      }
    }
    const { data, error } = await q.order("created_at", { ascending: false }).order("id", { ascending: false }).range(0, need - 1)
    if (error) throw new Error(`[REFUND] pending list failed for ${table}: ${error.message}`)
    for (const row of data ?? []) all.push({ table, id: row.id, createdAt: toUtcIso(row.created_at, table === "orders") })
  }
  all.sort((a, b) => cmpNewestFirst(a.createdAt, b.createdAt) || (`${a.table}:${a.id}` < `${b.table}:${b.id}` ? -1 : 1))
  return all.slice((opts.page - 1) * opts.pageSize, opts.page * opts.pageSize)
}
