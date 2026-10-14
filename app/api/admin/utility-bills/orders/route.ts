import { NextRequest, NextResponse } from "next/server"
import {
  applyOrderFilters, BILL_ORDERS_TABLE, canDispatch, fetchLedgerByOrders, isStuckClaim, fetchStats, parseOrderFilters, purchaserLabel, refundDecision,
} from "@/lib/bills/admin"
import { clampPage, errorJson, requireAdmin, searchAlternate } from "@/lib/hubtel-cs/admin-route"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"

export const dynamic = "force-dynamic"

// Never select verify_token_hash or session_id.
const COLUMNS =
  "id, reference_code, user_id, channel, biller, account_number, phone, email, broadband_account, customer_name, verified, amount, paid_amount, status, payment_status, hubtel_client_reference, commission, failure_reason, notes, created_at, updated_at, shop_id, buyer_name, buyer_phone, buyer_email, payment_fee_amount"

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  const sp = new URL(request.url).searchParams
  const f = parseOrderFilters(sp)
  const qAlt = searchAlternate(f.q)
  const { limit, offset } = clampPage(sp)
  try {
    const { db } = getHubtelCsRuntime()
    const base = db.from(BILL_ORDERS_TABLE).select(COLUMNS, { count: "exact" })
    // Stats only on request and only for the Orders view; a stats failure must not break the list.
    const wantStats = sp.get("stats") === "1" && f.view === "all"
    const statsP = wantStats ? fetchStats(db, f, qAlt).catch((e): null => { console.error("[utility-bills] stats failed:", e?.message ?? e); return null }) : Promise.resolve(undefined)
    let page = await applyOrderFilters(base, f, qAlt).order("created_at", { ascending: false }).order("id", { ascending: true }).range(offset, offset + limit - 1)
    let rangeMiss = false
    if (page.error && ((page.error as any).code === "PGRST103" || (page as any).status === 416)) {
      // Offset beyond the end: report the real total with no rows instead of a 500.
      rangeMiss = true
      const c = await applyOrderFilters(db.from(BILL_ORDERS_TABLE).select("id", { count: "exact", head: true }), f, qAlt)
      if (c.error) throw c.error
      page = { ...page, data: [], error: null, count: c.count } as unknown as typeof page
    }
    if (page.error) throw page.error
    const stats = await statsP
    const orders = (page.data ?? []) as any[]

    // hubtel_bill_orders.user_id has no FK to users, so purchasers are looked up by id (users.email, as the airtime list shows).
    const userIds = [...new Set(orders.map(o => o.user_id).filter(Boolean))]
    const users = new Map<string, any>()
    if (userIds.length) {
      const { data, error } = await db.from("users").select("id, email, first_name, last_name").in("id", userIds)
      if (error) throw error
      for (const u of data ?? []) users.set((u as any).id, u)
    }
    // Storefront rows carry a shop_id; resolve shop names (user_shops.shop_name).
    const shopIds = [...new Set(orders.map(o => o.shop_id).filter(Boolean))]
    const shops = new Map<string, string>()
    if (shopIds.length) {
      const { data, error } = await db.from("user_shops").select("id, shop_name").in("id", shopIds)
      if (error) throw error
      for (const s of data ?? []) shops.set((s as any).id, (s as any).shop_name)
    }
    // Refund eligibility needs the ledger; fail closed (no refund offered) if it cannot be read.
    const isCandidate = (o: any) => o.payment_status === "paid" &&
      (o.status === "failed" || o.status === "pending" || (o.status === "processing" && !o.hubtel_client_reference && (o.notes ?? "").startsWith("Dispatching")))
    const refundCandidates = orders.filter(isCandidate)
    let ledger = new Map<string, any[]>()
    let ledgerOk = true
    try { ledger = await fetchLedgerByOrders(db, refundCandidates.map(o => o.id)) } catch { ledgerOk = false }

    const now = Date.now()
    const rows = orders.map(o => {
      const { verify_token_hash: _omit, ...safe } = o
      const stuck = ledgerOk && isCandidate(o) && o.status === "processing" && isStuckClaim(o, ledger.get(o.id) ?? [], now)
      const decision = isCandidate(o)
        ? (ledgerOk ? refundDecision(o, ledger.get(o.id) ?? [], now) : { action: "blocked" as const, reason: "Could not read the Hubtel ledger; try again" })
        : null
      return {
        ...safe,
        purchaser: o.channel === "storefront"
          ? (o.buyer_name || o.buyer_phone || "Storefront buyer")
          : purchaserLabel(users.get(o.user_id)),
        purchaser_email: o.channel === "storefront" ? (o.buyer_email ?? null) : (users.get(o.user_id)?.email ?? null),
        source: o.channel === "storefront" ? "storefront" : "dashboard",
        shop_name: o.shop_id ? (shops.get(o.shop_id) ?? "Unknown shop") : null,
        can_dispatch: canDispatch(o, stuck),
        stuck_claim: stuck,
        refund: decision,
      }
    })
    return NextResponse.json({ rows, total: page.count ?? 0, ...(stats !== undefined ? { stats } : {}), ...(rangeMiss ? { rangeMiss: true } : {}) })
  } catch (e) {
    return errorJson(e)
  }
}
