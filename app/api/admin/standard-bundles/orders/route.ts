import { NextRequest, NextResponse } from "next/server"
import {
  applyOrderFilters, bundleRefundDecision, DATA_ORDERS_TABLE, fetchLedgerOrderIds, isStuckClaim, ORDER_STATUSES, parseOrderFilters,
} from "@/lib/standard-bundles/admin"
import { clampPage, errorJson, requireAdmin, searchAlternate } from "@/lib/hubtel-cs/admin-route"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"

export const dynamic = "force-dynamic"

// Explicit columns; never select idempotency_key.
const COLUMNS =
  "id, reference_code, user_id, channel, network, service_key, beneficiary_phone, bundle_value, bundle_display, bundle_category, amount, paid_amount, status, payment_status, hubtel_client_reference, commission, failure_reason, notes, created_at, updated_at, shop_id, buyer_name, buyer_phone, buyer_email, payment_fee_amount"

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  const sp = new URL(request.url).searchParams
  const f = parseOrderFilters(sp)
  const qAlt = searchAlternate(f.q)
  const { limit, offset } = clampPage(sp)
  try {
    const { db } = getHubtelCsRuntime()
    let page = await applyOrderFilters(db.from(DATA_ORDERS_TABLE).select(COLUMNS, { count: "exact" }), f, qAlt)
      .order("created_at", { ascending: false }).order("id", { ascending: true }).range(offset, offset + limit - 1)
    if (page.error && ((page.error as any).code === "PGRST103" || (page as any).status === 416)) {
      const c = await applyOrderFilters(db.from(DATA_ORDERS_TABLE).select("id", { count: "exact", head: true }), f, qAlt)
      if (c.error) throw c.error
      page = { ...page, data: [], error: null, count: c.count } as unknown as typeof page
    }
    if (page.error) throw page.error
    const orders = (page.data ?? []) as any[]

    // Status counts over the filtered window (volume is small; one head-count query per status). A failure degrades to no stats.
    let stats: Record<string, number> | null = null
    if (sp.get("stats") === "1") {
      try {
        const base: typeof f = { ...f, status: undefined }
        const counts = await Promise.all(ORDER_STATUSES.map(async s => {
          const r = await applyOrderFilters(db.from(DATA_ORDERS_TABLE).select("id", { count: "exact", head: true }), base, qAlt).eq("status", s)
          if (r.error) throw r.error
          return [s, r.count ?? 0] as const
        }))
        stats = Object.fromEntries(counts)
      } catch (e: any) { console.error("[standard-bundles] stats failed:", e?.message ?? e); stats = null }
    }

    const userIds = [...new Set(orders.map(o => o.user_id).filter(Boolean))]
    const users = new Map<string, any>()
    if (userIds.length) {
      const { data, error } = await db.from("users").select("id, email, first_name, last_name").in("id", userIds)
      if (error) throw error
      for (const u of data ?? []) users.set((u as any).id, u)
    }

    const shopIds = [...new Set(orders.map(o => o.shop_id).filter(Boolean))]
    const shops = new Map<string, string>()
    if (shopIds.length) {
      const { data, error } = await db.from("user_shops").select("id, shop_name").in("id", shopIds)
      if (error) throw error
      for (const s of data ?? []) shops.set((s as any).id, (s as any).shop_name)
    }

    // Refund eligibility needs the ledger; fail closed (no refund offered) if it cannot be read.
    const candidates = orders.filter(o => o.payment_status === "paid" && ["pending", "failed", "processing"].includes(o.status))
    let ledger = new Set<string>()
    let ledgerOk = true
    try { ledger = await fetchLedgerOrderIds(db, candidates.map(o => o.id)) } catch { ledgerOk = false }

    const now = Date.now()
    const rows = orders.map(o => {
      const isCandidate = candidates.includes(o)
      const decision = isCandidate
        ? (ledgerOk ? bundleRefundDecision(o, ledger.has(o.id) ? 1 : 0, now) : { action: "blocked" as const, reason: "Could not read the Hubtel ledger; try again" })
        : null
      const u = users.get(o.user_id)
      return {
        ...o,
        purchaser: o.channel === "storefront"
          ? (o.buyer_name || o.buyer_phone || "Storefront buyer")
          : ([u?.first_name, u?.last_name].filter(Boolean).join(" ").trim() || u?.email || "Unknown"),
        shop_name: o.shop_id ? (shops.get(o.shop_id) ?? "Unknown shop") : null,
        stuck_claim: ledgerOk && isCandidate && !ledger.has(o.id) && isStuckClaim(o, now),
        has_ledger: ledgerOk && isCandidate ? ledger.has(o.id) : null,
        refund: decision,
      }
    })
    return NextResponse.json({ rows, total: page.count ?? 0, stats })
  } catch (e) {
    return errorJson(e)
  }
}
