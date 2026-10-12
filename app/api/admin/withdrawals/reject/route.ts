import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { notifyUserOfOutcome } from "@/lib/admin-actions"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { withdrawalId, reason } = await request.json()

    if (!withdrawalId) {
      return NextResponse.json({ error: "Withdrawal ID required" }, { status: 400 })
    }

    // Get the withdrawal request
    const { data: withdrawal, error: fetchError } = await supabase
      .from("withdrawal_requests")
      .select("id, shop_id, amount, status, user_id, account_details, withdrawal_method")
      .eq("id", withdrawalId)
      .single()

    if (fetchError || !withdrawal) {
      return NextResponse.json({ error: "Withdrawal not found" }, { status: 404 })
    }

    // Guard: only allow rejecting withdrawals that haven't been transferred yet
    const rejectableStatuses = ["pending", "failed", "approved", "awaiting_transfer_otp"]
    if (!rejectableStatuses.includes(withdrawal.status)) {
      return NextResponse.json(
        { error: `Cannot reject a withdrawal with status: ${withdrawal.status}` },
        { status: 400 }
      )
    }

    // Update withdrawal status to rejected with reason
    const { data: rejectedRows, error: updateError } = await supabase
      .from("withdrawal_requests")
      .update({
        status: "rejected",
        rejection_reason: reason || "No reason provided",
        updated_at: new Date().toISOString(),
      })
      .eq("id", withdrawalId)
      .in("status", rejectableStatuses)
      .select("id")

    if (updateError) {
      throw new Error(`Failed to update withdrawal: ${updateError.message}`)
    }

    // Another admin action changed the row between our status check and this update.
    if (!rejectedRows || rejectedRows.length === 0) {
      return NextResponse.json({ error: "Withdrawal was already handled" }, { status: 409 })
    }

    console.log(`[WITHDRAWAL-REJECT] Withdrawal ${withdrawalId} rejected - Amount: GHS ${withdrawal.amount}`)

    // Notify the shop owner (email, SMS, push, in-app via the central notifier)
    try {
      const { data: shop } = await supabase.from("user_shops").select("user_id, shop_name").eq("id", withdrawal.shop_id).single()
      if (shop) {
        const { data: bal } = await supabase.from("shop_available_balance").select("available_balance").eq("shop_id", withdrawal.shop_id).single()
        const details = (withdrawal.account_details ?? {}) as any
        await notifyUserOfOutcome("withdrawal", "rejected", { userId: shop.user_id, reference: withdrawalId }, {
          withdrawalId,
          amount: Number(withdrawal.amount),
          shopName: shop.shop_name ?? null,
          method: withdrawal.withdrawal_method || details?.network || null,
          phone: details?.phone || details?.account_number || null,
          reason: typeof reason === "string" && reason.trim() ? reason.trim() : undefined,
          remainingBalance: bal?.available_balance != null ? Number(bal.available_balance).toFixed(2) : null,
        })
      }
    } catch (notifError) {
      console.warn("[ADMIN-ACTION] withdrawal rejection notify failed:", notifError instanceof Error ? notifError.message : notifError)
    }

    // Sync available balance after rejection (paginated, upsert to avoid race conditions)
    try {
      let allProfits: any[] = []
      let profitOffset = 0
      while (true) {
        const { data: batch, error } = await supabase
          .from("shop_profits")
          .select("profit_amount, status")
          .eq("shop_id", withdrawal.shop_id)
          .range(profitOffset, profitOffset + 999)
        if (error) throw error
        if (!batch || batch.length === 0) break
        allProfits = allProfits.concat(batch)
        if (batch.length < 1000) break
        profitOffset += 1000
      }

      const breakdown = { totalProfit: 0, creditedProfit: 0, withdrawnProfit: 0 }
      allProfits.forEach((p: any) => {
        const amount = p.profit_amount || 0
        breakdown.totalProfit += amount
        if (p.status === "credited")  breakdown.creditedProfit  += amount
        if (p.status === "withdrawn") breakdown.withdrawnProfit += amount
      })

      // Get approved withdrawals (rejected one is no longer counted — status is now "rejected")
      let allApproved: any[] = []
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
        allApproved = allApproved.concat(batch)
        if (batch.length < 1000) break
        wOffset += 1000
      }
      const totalApprovedWithdrawals = allApproved.reduce((s, w) => s + (w.amount || 0), 0)

      const availableBalance = Math.max(0, breakdown.creditedProfit - totalApprovedWithdrawals)

      const { error: upsertError } = await supabase
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

      if (upsertError) {
        console.error(`[WITHDRAWAL-REJECT] Balance upsert failed:`, upsertError)
      } else {
        console.log(`[WITHDRAWAL-REJECT] Balance restored for shop: ${withdrawal.shop_id} - Available: GHS ${availableBalance.toFixed(2)}`)
      }
    } catch (syncError) {
      console.warn(`[WITHDRAWAL-REJECT] Warning restoring balance:`, syncError)
    }

    return NextResponse.json({
      success: true,
      message: "Withdrawal rejected successfully",
    })
  } catch (error) {
    console.error("[WITHDRAWAL-REJECT] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
