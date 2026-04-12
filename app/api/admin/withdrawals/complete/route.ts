import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

/**
 * POST /api/admin/withdrawals/complete
 * Marks an approved withdrawal as completed, marks matching profits as withdrawn,
 * and syncs the available balance.
 */
export async function POST(request: NextRequest) {
  const { isAdmin, userId: adminId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const { withdrawalId } = await request.json()
  if (!withdrawalId || typeof withdrawalId !== "string") {
    return NextResponse.json({ error: "withdrawalId is required" }, { status: 400 })
  }

  const { data: withdrawal, error: fetchError } = await supabase
    .from("withdrawal_requests")
    .select("id, shop_id, amount, status")
    .eq("id", withdrawalId)
    .single()

  if (fetchError || !withdrawal) {
    return NextResponse.json({ error: "Withdrawal not found" }, { status: 404 })
  }

  if (withdrawal.status !== "approved") {
    return NextResponse.json(
      { error: `Only approved withdrawals can be marked as completed (current: ${withdrawal.status})` },
      { status: 400 }
    )
  }

  // Mark withdrawal as completed
  const { error: updateError } = await supabase
    .from("withdrawal_requests")
    .update({ status: "completed", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", withdrawalId)

  if (updateError) {
    return NextResponse.json({ error: `Failed to update withdrawal: ${updateError.message}` }, { status: 500 })
  }

  console.log(`[WITHDRAWAL-COMPLETE] Admin ${adminId} marked withdrawal ${withdrawalId} as completed — Amount: GHS ${withdrawal.amount}`)

  // Mark profits as withdrawn (oldest credited first, up to the withdrawal amount)
  try {
    let allProfits: any[] = []
    let offset = 0
    while (true) {
      const { data: batch, error } = await supabase
        .from("shop_profits")
        .select("id, profit_amount")
        .eq("shop_id", withdrawal.shop_id)
        .eq("status", "credited")
        .order("created_at", { ascending: true })
        .range(offset, offset + 999)
      if (error) throw error
      if (!batch || batch.length === 0) break
      allProfits = allProfits.concat(batch)
      if (batch.length < 1000) break
      offset += 1000
    }

    let remaining = withdrawal.amount
    const toMark: string[] = []

    for (const profit of allProfits) {
      if (remaining <= 0) break
      if (profit.profit_amount <= remaining) {
        toMark.push(profit.id)
        remaining -= profit.profit_amount
      }
      // Skip profits larger than remaining (can't partially mark)
    }

    if (toMark.length > 0) {
      await supabase
        .from("shop_profits")
        .update({ status: "withdrawn", updated_at: new Date().toISOString() })
        .in("id", toMark)

      console.log(`[WITHDRAWAL-COMPLETE] Marked ${toMark.length} profit records as withdrawn for shop ${withdrawal.shop_id}`)
    }
  } catch (profitError) {
    console.warn(`[WITHDRAWAL-COMPLETE] Warning marking profits as withdrawn:`, profitError)
    // Non-fatal — withdrawal is already marked complete
  }

  // Sync available balance (paginated, upsert)
  try {
    let allProfits: any[] = []
    let offset = 0
    while (true) {
      const { data: batch, error } = await supabase
        .from("shop_profits")
        .select("profit_amount, status")
        .eq("shop_id", withdrawal.shop_id)
        .range(offset, offset + 999)
      if (error) throw error
      if (!batch || batch.length === 0) break
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

    // Get remaining approved withdrawals (this one is now "completed", not "approved")
    let approvedTotal = 0
    let wOffset = 0
    while (true) {
      const { data: batch, error } = await supabase
        .from("withdrawal_requests")
        .select("amount")
        .eq("shop_id", withdrawal.shop_id)
        .eq("status", "approved")
        .range(wOffset, wOffset + 999)
      if (error) break
      if (!batch || batch.length === 0) break
      approvedTotal += batch.reduce((s, w) => s + (w.amount || 0), 0)
      if (batch.length < 1000) break
      wOffset += 1000
    }

    const availableBalance = Math.max(0, breakdown.creditedProfit - approvedTotal)

    await supabase
      .from("shop_available_balance")
      .upsert(
        {
          shop_id: withdrawal.shop_id,
          available_balance: availableBalance,
          total_profit: breakdown.totalProfit,
          withdrawn_amount: breakdown.withdrawnProfit,
          credited_profit: breakdown.creditedProfit,
          withdrawn_profit: breakdown.withdrawnProfit,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "shop_id" }
      )

    console.log(`[WITHDRAWAL-COMPLETE] Balance synced for shop ${withdrawal.shop_id} — Available: GHS ${availableBalance.toFixed(2)}`)
  } catch (syncError) {
    console.warn(`[WITHDRAWAL-COMPLETE] Warning syncing balance:`, syncError)
  }

  return NextResponse.json({ success: true, message: "Withdrawal marked as completed" })
}
