import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { notificationTemplates } from "@/lib/notification-service"
import { sendSMS } from "@/lib/sms-service"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { initiateTransfer } from "@/lib/moolre-transfer"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

    const totalWithdrawn  = Number(breakdown.total_w) || 0
    const availableBalance = creditedProfit - totalWithdrawn

    console.log(`[WITHDRAWAL-BALANCE-SYNC] Shop ${shopId}:`, {
      creditedProfit,
      totalWithdrawn,
      availableBalance,
    })

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
    console.error(`[WITHDRAWAL-BALANCE-SYNC] Unexpected error for shop ${shopId}:`, err)
  }
}


/** Send in-app notification + SMS to the shop owner. */
async function notifyShopOwner(withdrawal: any, withdrawalId: string) {
  try {
    const { data: shop } = await supabase
      .from("user_shops")
      .select("user_id")
      .eq("id", withdrawal.shop_id)
      .single()

    if (!shop) return

    const notificationData = notificationTemplates.withdrawalApproved(withdrawal.amount, withdrawalId)
    const { error: notifError } = await supabase.from("notifications").insert([{
      user_id: shop.user_id,
      title: notificationData.title,
      message: notificationData.message,
      type: notificationData.type,
      reference_id: notificationData.reference_id,
      action_url: `/dashboard/shop-dashboard`,
      read: false,
    }])
    if (notifError) console.warn("[NOTIFICATION] Failed:", notifError)

    const { data: userData } = await supabase
      .from("users")
      .select("phone_number, email, first_name")
      .eq("id", shop.user_id)
      .single()

    if (!userData) return

    if (userData.email) {
      import("@/lib/email-service").then(async ({ sendEmail, EmailTemplates }) => {
        const accountDetails = withdrawal.account_details as any
        const paymentMethod = withdrawal.withdrawal_method || accountDetails?.network || "Mobile Money"
        const recipientPhone = accountDetails?.phone || accountDetails?.account_number || userData.phone_number

        const { data: balanceData } = await supabase
          .from("shop_balances")
          .select("available_balance")
          .eq("shop_id", withdrawal.shop_id)
          .single()

        const remainingBalance = balanceData?.available_balance?.toFixed(2)
        const payload = EmailTemplates.withdrawalApproved(
          withdrawal.amount.toFixed(2),
          withdrawalId,
          remainingBalance,
          paymentMethod,
          recipientPhone
        )

        sendEmail({
          to: [{ email: userData.email, name: userData.first_name || "Merchant" }],
          subject: payload.subject,
          htmlContent: payload.html,
          referenceId: withdrawalId,
          userId: shop.user_id,
          type: "withdrawal_approved",
        }).catch(err => console.error("[EMAIL] Withdrawal approval email failed:", err))
      })
    }

    if (userData.phone_number) {
      const accountDetails = withdrawal.account_details as any
      const smsMessage = `✓ Your withdrawal of GHS ${withdrawal.amount.toFixed(2)} has been transferred to ${accountDetails?.phone || accountDetails?.account_number || "your account"}.`
      await sendSMS({
        phone: userData.phone_number,
        message: smsMessage,
        type: "withdrawal_approved",
        reference: withdrawalId,
      }).catch(err => console.error("[SMS] SMS error:", err))
    }
  } catch (err) {
    console.warn("[WITHDRAWAL-APPROVE] Notification error (non-fatal):", err)
  }
}

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { withdrawalId } = await request.json()

    if (!withdrawalId || typeof withdrawalId !== "string") {
      return NextResponse.json({ error: "Withdrawal ID required" }, { status: 400 })
    }

    // CRITICAL FIX — Anti-double-spend: atomically move status to "processing" BEFORE
    // calling Moolre. This prevents two concurrent admin approvals from both passing
    // the status check and initiating duplicate transfers.
    // The update only succeeds if status is currently "pending" or "failed" — DB enforces this.
    const { data: locked, error: lockError } = await supabase
      .from("withdrawal_requests")
      .update({
        status: "processing",
        transfer_attempted_at: new Date().toISOString(),
        moolre_external_ref: withdrawalId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", withdrawalId)
      .in("status", ["pending", "failed"])
      .select("id, shop_id, amount, fee_amount, net_amount, user_id, account_details, withdrawal_method")
      .single()

    if (lockError || !locked) {
      // Either not found, or another request already locked it
      const { data: existing } = await supabase
        .from("withdrawal_requests")
        .select("status")
        .eq("id", withdrawalId)
        .single()

      if (!existing) {
        return NextResponse.json({ error: "Withdrawal not found" }, { status: 404 })
      }
      return NextResponse.json(
        { error: `Cannot approve withdrawal with status: ${existing.status}` },
        { status: 400 }
      )
    }

    const withdrawal = locked
    const accountDetails = withdrawal.account_details as any
    const phone = accountDetails?.phone
    const network = accountDetails?.network

    // Validate amount is a positive finite number
    const amount = Number(withdrawal.amount)
    if (!isFinite(amount) || amount <= 0) {
      await supabase
        .from("withdrawal_requests")
        .update({ status: "pending", transfer_attempted_at: null, moolre_external_ref: null, updated_at: new Date().toISOString() })
        .eq("id", withdrawalId)
      return NextResponse.json({ error: "Invalid withdrawal amount" }, { status: 400 })
    }

    // Stamp balance_after on the withdrawal record for audit history
    try {
      const { data: breakdown } = await supabase.rpc("get_shop_balance_breakdown", {
        p_shop_id: withdrawal.shop_id
      })
      if (breakdown) {
        const balanceAfter = Number(breakdown.credited_p) - Number(breakdown.total_w)
        await supabase
          .from("withdrawal_requests")
          .update({ balance_after: balanceAfter })
          .eq("id", withdrawalId)
      }
    } catch (stampError) {
      console.warn(`[WITHDRAWAL-APPROVE] Warning stamping balance_after:`, stampError)
    }


    // For bank transfers — manual approval path (no Moolre)
    if (withdrawal.withdrawal_method === "bank_transfer" || !phone || !network) {
      await supabase
        .from("withdrawal_requests")
        .update({ status: "approved", updated_at: new Date().toISOString() })
        .eq("id", withdrawalId)
      await notifyShopOwner(withdrawal, withdrawalId)

      console.log(`[WITHDRAWAL-APPROVE] Bank/manual approval: ${withdrawalId}`)
      return NextResponse.json({ success: true, message: "Withdrawal approved (manual transfer required)" })
    }

    // Transfer the net amount (after fee deduction)
    const transferAmount = withdrawal.net_amount ?? withdrawal.amount
    if (!isFinite(Number(transferAmount)) || Number(transferAmount) <= 0) {
      await supabase
        .from("withdrawal_requests")
        .update({ status: "pending", transfer_attempted_at: null, moolre_external_ref: null, updated_at: new Date().toISOString() })
        .eq("id", withdrawalId)
      return NextResponse.json({ error: "Invalid transfer amount" }, { status: 400 })
    }

    console.log(`[WITHDRAWAL-APPROVE] Transfer: gross=GHS ${withdrawal.amount}, fee=GHS ${withdrawal.fee_amount ?? 0}, net=GHS ${transferAmount}`)

    // Initiate Moolre transfer
    const result = await initiateTransfer({
      phone,
      network,
      amount: Number(transferAmount),
      externalref: withdrawalId,
      reference: `Datagod withdrawal ${withdrawalId.slice(0, 8)}`,
    })

    if (!result) {
      // API unreachable — revert to pending, admin can retry
      await supabase
        .from("withdrawal_requests")
        .update({
          status: "pending",
          transfer_attempted_at: null,
          moolre_external_ref: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", withdrawalId)

      return NextResponse.json(
        { error: "Could not reach payment provider. Please try again." },
        { status: 503 }
      )
    }

    if (result.txstatus === 1) {
      // Transfer succeeded immediately — mark completed and sync balance
      await supabase
        .from("withdrawal_requests")
        .update({
          status: "completed",
          moolre_transfer_id: result.transactionId,
          moolre_fee: result.fee,
          transfer_completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", withdrawalId)

      await notifyShopOwner(withdrawal, withdrawalId)

      console.log(`[WITHDRAWAL-APPROVE] Completed: ${withdrawalId} — Moolre TX: ${result.transactionId}`)
      return NextResponse.json({ success: true, message: "Withdrawal approved and transferred successfully" })
    }

    if (result.txstatus === 2) {
      // Explicit failure — revert to pending so admin can retry
      await supabase
        .from("withdrawal_requests")
        .update({
          status: "pending",
          transfer_attempted_at: null,
          moolre_external_ref: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", withdrawalId)

      const reason = result.insufficientBalance
        ? "Insufficient balance in Moolre account. Please top up and retry."
        : result.errorMessage
        ? `Transfer rejected: ${result.errorMessage}`
        : "Transfer failed. Withdrawal remains pending."

      console.error(`[WITHDRAWAL-APPROVE] Transfer failed: ${withdrawalId} — ${reason}`)
      return NextResponse.json({ error: reason }, { status: 400 })
    }

    // txstatus=0 (pending) or 3 (unknown) — already in "processing", cron will poll
    if (result.transactionId) {
      await supabase
        .from("withdrawal_requests")
        .update({
          moolre_transfer_id: result.transactionId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", withdrawalId)
    }

    const isPending = result.txstatus === 0
    console.log(`[WITHDRAWAL-APPROVE] ${isPending ? "Processing" : "Unknown status"}: ${withdrawalId}`)
    return NextResponse.json({
      success: true,
      status: "processing",
      message: isPending
        ? "Transfer initiated. Awaiting mobile money confirmation."
        : "Transfer status unknown — monitoring for completion automatically.",
    })
  } catch (error) {
    console.error("[WITHDRAWAL-APPROVE] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
