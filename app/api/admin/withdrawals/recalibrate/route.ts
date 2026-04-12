import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

/**
 * POST /api/admin/withdrawals/recalibrate
 * Recalculates the correct available balance for every shop by summing
 * credited profits minus approved withdrawals. Fixes shops where the
 * balance was not properly deducted after a withdrawal was approved.
 */
export async function POST(request: NextRequest) {
  const { isAdmin, userId: adminId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  console.log(`[RECALIBRATE] Admin ${adminId} triggered balance recalibration`)

  // Get all distinct shop IDs that have any balance record or withdrawal
  const [{ data: balanceShops }, { data: withdrawalShops }] = await Promise.all([
    supabase.from("shop_available_balance").select("shop_id"),
    supabase.from("withdrawal_requests").select("shop_id"),
  ])

  const shopIds = [
    ...new Set([
      ...(balanceShops || []).map((r: any) => r.shop_id),
      ...(withdrawalShops || []).map((r: any) => r.shop_id),
    ]),
  ]

  if (shopIds.length === 0) {
    return NextResponse.json({ success: true, message: "No shops to recalibrate", updated: 0 })
  }

  const results: { shopId: string; old: number | null; new: number; status: string }[] = []

  for (const shopId of shopIds) {
    try {
      // Paginate profits
      let allProfits: any[] = []
      let offset = 0
      while (true) {
        const { data: batch, error } = await supabase
          .from("shop_profits")
          .select("profit_amount, status")
          .eq("shop_id", shopId)
          .range(offset, offset + 999)
        if (error || !batch || batch.length === 0) break
        allProfits = allProfits.concat(batch)
        if (batch.length < 1000) break
        offset += 1000
      }

      const breakdown = { totalProfit: 0, creditedProfit: 0, withdrawnProfit: 0 }
      allProfits.forEach((p: any) => {
        const amount = p.profit_amount || 0
        breakdown.totalProfit += amount
        if (p.status === "credited")  breakdown.creditedProfit  += amount
        if (p.status === "withdrawn") breakdown.withdrawnProfit += amount
      })

      // Paginate approved withdrawals
      let approvedTotal = 0
      let wOffset = 0
      while (true) {
        const { data: batch, error } = await supabase
          .from("withdrawal_requests")
          .select("amount")
          .eq("shop_id", shopId)
          .eq("status", "approved")
          .range(wOffset, wOffset + 999)
        if (error || !batch || batch.length === 0) break
        approvedTotal += batch.reduce((s: number, w: any) => s + (w.amount || 0), 0)
        if (batch.length < 1000) break
        wOffset += 1000
      }

      const correctBalance = Math.max(0, breakdown.creditedProfit - approvedTotal)

      // Read current balance for the report
      const { data: current } = await supabase
        .from("shop_available_balance")
        .select("available_balance")
        .eq("shop_id", shopId)
        .single()

      const oldBalance = current?.available_balance ?? null

      // Upsert correct balance
      const { error: upsertError } = await supabase
        .from("shop_available_balance")
        .upsert(
          {
            shop_id: shopId,
            available_balance: correctBalance,
            total_profit: breakdown.totalProfit,
            credited_profit: breakdown.creditedProfit,
            withdrawn_profit: breakdown.withdrawnProfit,
            withdrawn_amount: breakdown.withdrawnProfit,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "shop_id" }
        )

      results.push({
        shopId,
        old: oldBalance,
        new: correctBalance,
        status: upsertError ? `error: ${upsertError.message}` : "ok",
      })
    } catch (err: any) {
      results.push({ shopId, old: null, new: 0, status: `error: ${err.message}` })
    }
  }

  const updated = results.filter(r => r.status === "ok").length
  const errors  = results.filter(r => r.status !== "ok").length
  const changed = results.filter(r => r.status === "ok" && r.old !== r.new)

  console.log(`[RECALIBRATE] Done — ${updated} shops updated, ${errors} errors, ${changed.length} balances changed`)

  return NextResponse.json({
    success: true,
    summary: { total: shopIds.length, updated, errors, balancesChanged: changed.length },
    changes: changed.map(r => ({
      shopId: r.shopId,
      before: r.old,
      after: r.new,
      diff: (r.new - (r.old ?? 0)).toFixed(2),
    })),
  })
}
