import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { getTransferStatus } from "@/lib/moolre-transfer"
import { getTransferStatus as getPaystackTransferStatus } from "@/lib/paystack-transfer"
import { notifyWithdrawalCompleted } from "@/lib/admin-actions/withdrawal-hook"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function syncShopBalance(shopId: string) {
  try {
    const { data: breakdown } = await supabase.rpc("get_shop_balance_breakdown", { p_shop_id: shopId })
    if (!breakdown) return

    const creditedProfit   = Number(breakdown.credited_p) || 0
    const totalWithdrawn   = Number(breakdown.total_w) || 0
    const availableBalance = creditedProfit - totalWithdrawn

    await supabase.from("shop_available_balance").upsert({
      shop_id: shopId,
      available_balance: availableBalance,
      total_profit: Number(breakdown.total_p) || 0,
      withdrawn_amount: totalWithdrawn,
      credited_profit: creditedProfit,
      withdrawn_profit: Number(breakdown.withdrawn_p) || 0,
      updated_at: new Date().toISOString(),
    }, { onConflict: "shop_id" })
  } catch (err) {
    console.error(`[CRON-BALANCE-SYNC] Error syncing shop ${shopId}:`, err)
  }
}

export async function GET(request: NextRequest) {
  // Secure cron endpoint — Vercel sends Authorization: Bearer <CRON_SECRET>
  // Fail-closed: if CRON_SECRET is unset in production, deny all requests
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.error("[CRON-STATUS] CRON_SECRET env var is not set — denying all requests")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    // Fetch all withdrawals in "processing" state that have a Moolre reference
    const { data: processingWithdrawals, error } = await supabase
      .from("withdrawal_requests")
      .select("id, shop_id, amount, account_details, withdrawal_method, moolre_external_ref, moolre_transfer_id")
      .eq("status", "processing")
      .not("moolre_external_ref", "is", null)

    if (error) {
      console.error("[CRON-STATUS] Fetch error:", error)
      return NextResponse.json({ error: "Failed to fetch processing withdrawals" }, { status: 500 })
    }

    // Paystack rows awaiting reconciliation. Selected here — BEFORE the
    // early-return below — because the common case is zero Moolre "processing"
    // rows, and returning early on that alone would make the Paystack loop
    // dead code in exactly the situation it exists for.
    // "awaiting_transfer_otp" is included as well: a Paystack transfer that came
    // back "pending" (rather than "otp") is bucketed there by the approve route
    // but will never receive an OTP, so polling is its only route to resolution.
    // The paystack_transfer_code guard is defense-in-depth — a row with no real
    // Paystack transfer can never be polled against Paystack even if
    // payout_provider were somehow wrong.
    const { data: paystackProcessing } = await supabase
      .from("withdrawal_requests")
      .select("id, shop_id, amount, account_details, withdrawal_method")
      .in("status", ["processing", "awaiting_transfer_otp"])
      .eq("payout_provider", "paystack")
      .not("paystack_transfer_code", "is", null)

    if (
      (!processingWithdrawals || processingWithdrawals.length === 0) &&
      (!paystackProcessing || paystackProcessing.length === 0)
    ) {
      return NextResponse.json({ processed: 0, completed: 0, failed: 0, pending: 0 })
    }

    let completed = 0
    let failed = 0
    let pending = 0

    for (const withdrawal of processingWithdrawals ?? []) {
      const statusResult = await getTransferStatus(withdrawal.moolre_external_ref)

      if (!statusResult) {
        // Can't reach Moolre API at all — skip, try next run
        console.warn(`[CRON-STATUS] Could not reach Moolre for withdrawal ${withdrawal.id}`)
        pending++
        continue
      }

      // txstatus=3 with no transactionId means Moolre has no record of this transfer.
      // This happens when the transfer was never actually initiated (e.g. insufficient balance
      // rejected before Moolre created a transaction). Reset to pending so admin can retry.
      if (statusResult.txstatus === 3 && !statusResult.transactionId && !withdrawal.moolre_transfer_id) {
        await supabase
          .from("withdrawal_requests")
          .update({
            status: "pending",
            moolre_external_ref: null,
            transfer_attempted_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", withdrawal.id)

        console.warn(`[CRON-STATUS] No Moolre record found — reset to pending: ${withdrawal.id}`)
        pending++
        continue
      }

      if (statusResult.txstatus === 1) {
        // Transfer confirmed — complete it and sync balance
        const { data: flipped } = await supabase
          .from("withdrawal_requests")
          .update({
            status: "completed",
            moolre_transfer_id: statusResult.transactionId || withdrawal.moolre_transfer_id,
            transfer_completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", withdrawal.id)
          .eq("status", "processing")
          .select("id")

        await syncShopBalance(withdrawal.shop_id)
        // Notify only the run that actually flipped the row out of "processing"
        if (flipped && flipped.length > 0) await notifyWithdrawalCompleted(supabase, withdrawal)

        console.log(`[CRON-STATUS] Completed: ${withdrawal.id} — TX: ${statusResult.transactionId}`)
        completed++
      } else if (statusResult.txstatus === 2) {
        // Transfer failed — mark failed, do NOT deduct balance
        await supabase
          .from("withdrawal_requests")
          .update({
            status: "failed",
            updated_at: new Date().toISOString(),
          })
          .eq("id", withdrawal.id)

        console.error(`[CRON-STATUS] Failed: ${withdrawal.id}`)
        failed++
      } else {
        // txstatus=0 (still pending) or txstatus=3 (unknown) — check again next run
        pending++
      }
    }

    // Reconcile Paystack transfers stuck mid-flight (rare — most complete
    // synchronously via submit-transfer-otp or asynchronously via the
    // transfer.success webhook; this only catches a timing gap between the two).
    // The rows were selected above, before the early-return.
    for (const withdrawal of paystackProcessing ?? []) {
      try {
        const result = await getPaystackTransferStatus(withdrawal.id)
        if (!result) continue

        if (result.status === "success") {
          const { data: flipped } = await supabase
            .from("withdrawal_requests")
            .update({
              status: "completed",
              paystack_fee: result.fee,
              transfer_completed_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", withdrawal.id)
            .in("status", ["processing", "awaiting_transfer_otp"])
            .select("id")
          await syncShopBalance(withdrawal.shop_id)
          // Notify only if this run actually flipped the row (webhook/OTP route may have completed it first)
          if (flipped && flipped.length > 0) await notifyWithdrawalCompleted(supabase, withdrawal)
          console.log(`[CRON-WITHDRAWALS] Paystack transfer completed: ${withdrawal.id}`)
        } else if (result.status === "failed") {
          await supabase
            .from("withdrawal_requests")
            .update({
              status: "pending",
              transfer_attempted_at: null,
              paystack_transfer_code: null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", withdrawal.id)
          console.warn(`[CRON-WITHDRAWALS] Paystack transfer failed, reverted to pending: ${withdrawal.id}`)
        }
        // "otp" or "pending" — leave as-is, still resolving
      } catch (err) {
        console.error(`[CRON-WITHDRAWALS] Error polling Paystack transfer ${withdrawal.id}:`, err)
      }
    }

    const summary = {
      processed: processingWithdrawals?.length ?? 0,
      completed,
      failed,
      pending,
    }

    console.log("[CRON-STATUS] Run complete:", summary)
    return NextResponse.json(summary)
  } catch (error) {
    console.error("[CRON-STATUS] Internal error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
