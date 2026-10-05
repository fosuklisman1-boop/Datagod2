import type { SupabaseClient } from "@supabase/supabase-js"
import type { DispatchOutcome, OrderTable, OwnerCut, PaymentSource, RefundableOrder } from "./types"

const CHUNK = 100
const PROFIT_FK: Record<OrderTable, string> = {
  shop_orders: "shop_order_id",
  ussd_orders: "ussd_order_id",
  ussd_shop_orders: "ussd_shop_order_id",
}
const TRACKING_COL: Record<OrderTable, string> = {
  shop_orders: "shop_order_id",
  ussd_orders: "order_id",
  ussd_shop_orders: "order_id",
}

const SELECT: Record<OrderTable, string> = {
  shop_orders:
    "id, shop_id, customer_phone, customer_email, network, volume_gb, total_price, order_status, payment_status, external_order_id, created_at",
  ussd_orders:
    "id, dialing_phone, recipient_phone, network, package_size, amount, order_status, payment_status, paystack_reference, created_at",
  ussd_shop_orders:
    "id, shop_id, dialing_phone, recipient_phone, network, package_size, amount, order_status, payment_status, paystack_reference, created_at",
}

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
    out.push(...(await enrich(db, table, rows)))
  }
  return out
}

async function enrich(db: SupabaseClient, table: OrderTable, rows: any[]): Promise<RefundableOrder[]> {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id as string)

  const [profits, tracking, claims, refunds, walletDebits, walletPayments] = await Promise.all([
    inRows<any>(db, "shop_profits", `shop_id, profit_amount, status, ${PROFIT_FK[table]}`, PROFIT_FK[table], ids, (q) => q.is("refund_id", null)),
    inRows<any>(db, "mtn_fulfillment_tracking", `status, ${TRACKING_COL[table]}`, TRACKING_COL[table], ids),
    inRows<any>(db, "order_dispatch_claims", "order_id, last_outcome, attempts", "order_id", ids),
    inRows<any>(db, "order_refunds", "order_id, status", "order_id", ids, (q) => q.neq("status", "failed")),
    inRows<any>(db, "transactions", "reference_id, user_id, type, amount", "reference_id", ids, (q) => q.eq("type", "debit")),
    table === "shop_orders" ? inRows<any>(db, "wallet_payments", "order_id, reference, amount, fee, status", "order_id", ids) : Promise.resolve([] as any[]),
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
    ...rows.map((r) => (table === "shop_orders" ? null : (r.paystack_reference ?? r.id)) as string | null).filter(Boolean) as string[],
  ]
  const attempts = paymentRefs.length ? await inRows<any>(db, "payment_attempts", "reference, fee", "reference", paymentRefs) : []

  const shopById = new Map(shops.map((s) => [s.id as string, s]))
  const balanceByShop = new Map(balances.map((b) => [b.shop_id as string, Number(b.available_balance)]))
  const walletByUser = new Map(wallets.map((w) => [w.user_id as string, Number(w.balance)]))
  const feeByRef = new Map(attempts.map((a) => [a.reference as string, Number(a.fee ?? 0)]))

  const result: RefundableOrder[] = []
  for (const r of rows) {
    const id = r.id as string
    const orderProfits = profits.filter((p) => p[PROFIT_FK[table]] === id)
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
    if (table === "shop_orders") {
      // customer_phone is the data RECIPIENT; the payer MoMo number is not stored for shop orders,
      // so payerPhone stays null (payout gateways must refuse; Paystack reversal / wallet still work).
      // wallet_payments.amount is the TOTAL charged (order price + fee); .fee is the fee part.
      const wp = walletPayments.find((w) => w.order_id === id && w.status === "completed")
      if (wp) {
        paid = Number(wp.amount)
        const debit = qualifyingDebit(paid)
        fee = Number(wp.fee ?? feeByRef.get(wp.reference) ?? 0)
        payment = {
          gateway: "paystack",
          reference: wp.reference ?? null,
          payerPhone: null,
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
    result.push({
      table, id,
      orderStatus: r.order_status, paymentStatus: r.payment_status,
      shopId: (r.shop_id as string | undefined) ?? null,
      shopName: r.shop_id ? (shopById.get(r.shop_id)?.shop_name as string | undefined) ?? null : null,
      packageLabel: table === "shop_orders" ? `${r.volume_gb}GB` : String(r.package_size ?? ""),
      network: r.network,
      recipientPhone: (r.recipient_phone ?? r.customer_phone ?? null) as string | null,
      createdAt: r.created_at,
      paid, gatewayFee: fee, payment, owners,
      evidence: {
        hasActiveRefund: refunds.some((x) => x.order_id === id),
        dispatchOutcome: (claim?.last_outcome as DispatchOutcome | undefined) ?? null,
        dispatchAttempts: claim ? Number(claim.attempts ?? 0) : null,
        trackingStatuses: tracking.filter((t) => t[TRACKING_COL[table]] === id).map((t) => t.status as string),
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

/** Newest-first merged page of paid+pending orders. Each table's top (page*pageSize) rows contain the global top. */
export async function listPendingOrderRefs(db: SupabaseClient, opts: PendingQuery): Promise<{ table: OrderTable; id: string; createdAt: string }[]> {
  const tables = (opts.table ? [opts.table] : (Object.keys(SELECT) as OrderTable[])).filter((t) => !(opts.shopId && t === "ussd_orders")) // ussd_orders has no shop_id: never return it unscoped
  const need = opts.pageSize * opts.page
  const all: { table: OrderTable; id: string; createdAt: string }[] = []
  for (const table of tables) {
    let q: any = db.from(table).select("id, created_at").eq("order_status", "pending").eq("payment_status", "completed")
    if (opts.shopId) q = q.eq("shop_id", opts.shopId)
    if (opts.q) {
      const term = opts.q.replace(/[^0-9a-zA-Z-]/g, "")
      if (term) {
        const cols = table === "shop_orders" ? ["customer_phone"] : ["dialing_phone", "recipient_phone"]
        q = q.or(cols.map((c) => `${c}.ilike.%${term}%`).join(",") + (/^[0-9a-f-]{36}$/i.test(term) ? `,id.eq.${term}` : ""))
      }
    }
    const { data, error } = await q.order("created_at", { ascending: false }).order("id", { ascending: false }).range(0, need - 1)
    if (error) throw new Error(`[REFUND] pending list failed for ${table}: ${error.message}`)
    for (const row of data ?? []) all.push({ table, id: row.id, createdAt: row.created_at })
  }
  all.sort((a, b) => (a.createdAt !== b.createdAt ? (a.createdAt < b.createdAt ? 1 : -1) : `${a.table}:${a.id}` < `${b.table}:${b.id}` ? -1 : 1))
  return all.slice((opts.page - 1) * opts.pageSize, opts.page * opts.pageSize)
}
