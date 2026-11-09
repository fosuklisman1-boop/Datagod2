import { NextRequest, NextResponse, after } from "next/server"
import { createClient } from "@supabase/supabase-js"
import crypto from "crypto"
import { handleChargeSuccess, handleChargeFailed } from "@/lib/payments/charge-events"
import { notifyWithdrawalCompleted } from "@/lib/admin-actions/withdrawal-hook"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)


/**
 * Webhook endpoint for Paystack payment notifications
 * Configure this URL in your Paystack dashboard settings
 */
export async function POST(request: NextRequest) {
  console.log("[WEBHOOK] ========== WEBHOOK CALLED ==========")
  try {
    const signature = request.headers.get("x-paystack-signature")
    if (!signature) {
      console.warn("[WEBHOOK] Missing signature")
      return NextResponse.json(
        { error: "Invalid request: missing signature" },
        { status: 401 }
      )
    }

    const body = await request.text()
    const hash = crypto.createHmac("sha512", paystackSecretKey).update(body).digest("hex")

    // Timing-safe comparison — sha512 hex is 128 chars so a string `===` would
    // leak side-channel timing info to a high-precision local attacker. In
    // practice not exploitable over the public internet but textbook-wrong.
    const expectedBuf = Buffer.from(hash, "hex")
    const actualBuf = Buffer.from(signature, "hex")
    if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
      console.warn("[WEBHOOK] Invalid signature")
      return NextResponse.json(
        { error: "Invalid signature" },
        { status: 401 }
      )
    }

    const event = JSON.parse(body)
    console.log("[WEBHOOK] Event type:", event.event)

    // Handle charge.success event
    const res =
      event.event === "charge.success"
        ? await handleChargeSuccess(event.data)
        : event.event === "charge.failed"
          ? await handleChargeFailed(event.data)
          : null
    if (res) return res

    if (
      event.event === "transfer.success" ||
      event.event === "transfer.failed" ||
      event.event === "transfer.reversed"
    ) {
      const withdrawalId = event.data?.reference
      if (!withdrawalId) {
        console.warn("[PAYSTACK-WEBHOOK] Transfer event with no reference:", event.event)
      } else {
        const { data: withdrawal } = await supabase
          .from("withdrawal_requests")
          .select("id, shop_id, amount, status, payout_provider, paystack_transfer_code, withdrawal_method, account_details")
          .eq("id", withdrawalId)
          .maybeSingle()

        // A transfer event may only mutate the row if it belongs to the row's
        // CURRENT live Paystack attempt. Without this, a delayed or redelivered
        // webhook for an abandoned/superseded attempt could resurrect a rejected
        // withdrawal back into the payout queue, or revert a live Moolre transfer.
        const eventTransferCode = event.data?.transfer_code
        const isCurrentPaystackAttempt = withdrawal
          && withdrawal.payout_provider === "paystack"
          && withdrawal.paystack_transfer_code
          && withdrawal.paystack_transfer_code === eventTransferCode

        if (
          isCurrentPaystackAttempt &&
          event.event === "transfer.success" &&
          ["awaiting_transfer_otp", "processing"].includes(withdrawal!.status)
        ) {
          const { data: flippedRows } = await supabase
            .from("withdrawal_requests")
            .update({
              status: "completed",
              paystack_fee: Number(event.data?.fee ?? 0) / 100,
              transfer_completed_at: new Date().toISOString(),
              moolre_external_ref: null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", withdrawalId)
            .in("status", ["awaiting_transfer_otp", "processing"])
            .select("id")

          try {
            const { data: breakdown } = await supabase.rpc("get_shop_balance_breakdown", { p_shop_id: withdrawal!.shop_id })
            if (breakdown) {
              const creditedProfit = Number(breakdown.credited_p) || 0
              const totalWithdrawn = Number(breakdown.total_w) || 0
              await supabase.from("shop_available_balance").upsert({
                shop_id: withdrawal!.shop_id,
                available_balance: creditedProfit - totalWithdrawn,
                total_profit: Number(breakdown.total_p) || 0,
                withdrawn_amount: totalWithdrawn,
                credited_profit: creditedProfit,
                withdrawn_profit: Number(breakdown.withdrawn_p) || 0,
                updated_at: new Date().toISOString(),
              }, { onConflict: "shop_id" })
            }
          } catch (err) {
            console.error("[PAYSTACK-WEBHOOK] Balance sync error:", err)
          }
          // Notify only if this event actually flipped the row (webhook redeliveries / OTP route / cron may have got there first)
          if (flippedRows && flippedRows.length > 0) {
            const w = withdrawal!
            after(() => notifyWithdrawalCompleted(supabase, w))
          }
          console.log(`[PAYSTACK-WEBHOOK] Transfer completed via webhook: ${withdrawalId}`)
        } else if (
          isCurrentPaystackAttempt &&
          (event.event === "transfer.failed" || event.event === "transfer.reversed") &&
          ["awaiting_transfer_otp", "processing"].includes(withdrawal!.status)
        ) {
          // Failed/reversed before the withdrawal ever completed — funds did not
          // reach the recipient, so hand it back to the pending queue.
          await supabase
            .from("withdrawal_requests")
            .update({
              status: "pending",
              transfer_attempted_at: null,
              moolre_external_ref: null,
              paystack_transfer_code: null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", withdrawalId)
          console.warn(`[PAYSTACK-WEBHOOK] Transfer ${event.event}, reverted to pending: ${withdrawalId}`)
        } else if (
          isCurrentPaystackAttempt &&
          event.event === "transfer.reversed" &&
          withdrawal!.status === "completed"
        ) {
          // Clawed back hours after the payout appeared to succeed (submit-transfer-otp
          // or the success branch above already marked it completed). Mark it failed —
          // it is no longer "completed", so the next recompute of the balance breakdown
          // naturally returns the shop's credited profit.
          await supabase
            .from("withdrawal_requests")
            .update({ status: "failed", updated_at: new Date().toISOString() })
            .eq("id", withdrawalId)

          try {
            const { data: breakdown } = await supabase.rpc("get_shop_balance_breakdown", { p_shop_id: withdrawal!.shop_id })
            if (breakdown) {
              const creditedProfit = Number(breakdown.credited_p) || 0
              const totalWithdrawn = Number(breakdown.total_w) || 0
              await supabase.from("shop_available_balance").upsert({
                shop_id: withdrawal!.shop_id,
                available_balance: creditedProfit - totalWithdrawn,
                total_profit: Number(breakdown.total_p) || 0,
                withdrawn_amount: totalWithdrawn,
                credited_profit: creditedProfit,
                withdrawn_profit: Number(breakdown.withdrawn_p) || 0,
                updated_at: new Date().toISOString(),
              }, { onConflict: "shop_id" })
            }
          } catch (err) {
            console.error("[PAYSTACK-WEBHOOK] Balance sync error (reversal-after-completion):", err)
          }
          console.warn(`[PAYSTACK-WEBHOOK] Completed transfer reversed after the fact, marked failed: ${withdrawalId}`)
        }
        // Anything else — a stray event for a row that is rejected/approved, or
        // one that belongs to a different/older Paystack transfer_code — is
        // deliberately ignored: it does not describe this row's live attempt.
      }
    }

    return NextResponse.json({ received: true })
  } catch (error) {
    console.error("[WEBHOOK] ✗ Error:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
