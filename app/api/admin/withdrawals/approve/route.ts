import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { notificationTemplates } from "@/lib/notification-service"
import { sendSMS } from "@/lib/sms-service"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { initiateTransfer } from "@/lib/moolre-transfer"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/** Recalculate and sync shop_available_balance after a withdrawal completes. */
async function syncShopBalance(shopId: string, withdrawalAmount: number) {
  const { data: profits, error: profitError } = await supabase
    .from("shop_profits")
    .select("profit_amount, status")
    .eq("shop_id", shopId)

  if (profitError || !profits) return

  let creditedProfit = 0
  let totalProfit = 0
  let withdrawnProfit = 0

  profits.forEach((p: any) => {
    const amount = p.profit_amount || 0
    totalProfit += amount
    if (p.status === "credited") creditedProfit += amount
    else if (p.status === "withdrawn") withdrawnProfit += amount
  })

  const { data: completedWithdrawals } = await supabase
    .from("withdrawal_requests")
    .select("amount")
    .eq("shop_id", shopId)
    .in("status", ["completed", "approved"])

  const totalCompleted = (completedWithdrawals || []).reduce(
    (sum: number, w: any) => sum + (w.amount || 0),
    0
  )

  const availableBalance = Math.max(0, creditedProfit - totalCompleted)

  console.log(`[WITHDRAWAL-APPROVE-BALANCE] Shop ${shopId}:`, {
    creditedProfit,
    totalCompleted,
    availableBalance,
  })

  await supabase.from("shop_available_balance").delete().eq("shop_id", shopId)
  await supabase.from("shop_available_balance").insert([{
    shop_id: shopId,
    available_balance: availableBalance,
    total_profit: totalProfit,
    withdrawn_amount: withdrawnProfit,
    credited_profit: creditedProfit,
    withdrawn_profit: withdrawnProfit,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }])
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

    // In-app notification
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

    // SMS + Email
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
      const smsMessage = `✓ Your withdrawal of GHS ${withdrawal.amount.toFixed(2)} has been approved and transferred to ${accountDetails?.phone || accountDetails?.account_number || "your account"}.`
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

    if (!withdrawalId) {
      return NextResponse.json({ error: "Withdrawal ID required" }, { status: 400 })
    }

    // Fetch withdrawal — only act on pending requests
    const { data: withdrawal, error: fetchError } = await supabase
      .from("withdrawal_requests")
      .select("id, shop_id, amount, fee_amount, net_amount, status, user_id, account_details, withdrawal_method")
      .eq("id", withdrawalId)
      .single()

    if (fetchError || !withdrawal) {
      return NextResponse.json({ error: "Withdrawal not found" }, { status: 404 })
    }

    if (withdrawal.status !== "pending" && withdrawal.status !== "failed") {
      return NextResponse.json(
        { error: `Cannot approve withdrawal with status: ${withdrawal.status}` },
        { status: 400 }
      )
    }

    const accountDetails = withdrawal.account_details as any
    const phone = accountDetails?.phone
    const network = accountDetails?.network

    // For bank transfers, fall back to manual (old) approval path
    if (withdrawal.withdrawal_method === "bank_transfer" || !phone || !network) {
      await supabase
        .from("withdrawal_requests")
        .update({ status: "approved", updated_at: new Date().toISOString() })
        .eq("id", withdrawalId)

      await syncShopBalance(withdrawal.shop_id, withdrawal.amount)
      await notifyShopOwner(withdrawal, withdrawalId)

      console.log(`[WITHDRAWAL-APPROVE] Bank/manual approval: ${withdrawalId}`)
      return NextResponse.json({ success: true, message: "Withdrawal approved (manual transfer required)" })
    }

    // Mark transfer as attempted — use withdrawal UUID as Moolre externalref
    await supabase
      .from("withdrawal_requests")
      .update({
        transfer_attempted_at: new Date().toISOString(),
        moolre_external_ref: withdrawalId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", withdrawalId)

    // Transfer the net amount (after fee deduction) — this is what the user actually receives.
    // withdrawal.amount = gross requested, withdrawal.net_amount = amount after platform fee.
    const transferAmount = withdrawal.net_amount ?? withdrawal.amount
    console.log(`[WITHDRAWAL-APPROVE] Transfer breakdown: gross=GHS ${withdrawal.amount}, fee=GHS ${withdrawal.fee_amount ?? 0}, net=GHS ${transferAmount}`)

    // Initiate Moolre transfer
    const result = await initiateTransfer({
      phone,
      network,
      amount: transferAmount,
      externalref: withdrawalId,
      reference: `Datagod withdrawal ${withdrawalId.slice(0, 8)}`,
    })

    if (!result) {
      // API unreachable — revert attempted_at, return 503, do not change status
      await supabase
        .from("withdrawal_requests")
        .update({
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
      // Transfer succeeded immediately
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

      await syncShopBalance(withdrawal.shop_id, withdrawal.amount)
      await notifyShopOwner(withdrawal, withdrawalId)

      console.log(`[WITHDRAWAL-APPROVE] Completed: ${withdrawalId} — Moolre TX: ${result.transactionId}`)
      return NextResponse.json({ success: true, message: "Withdrawal approved and transferred successfully" })
    }

    if (result.txstatus === 0) {
      // Transfer is pending (MoMo prompt sent) — cron will poll and complete
      await supabase
        .from("withdrawal_requests")
        .update({
          status: "processing",
          moolre_transfer_id: result.transactionId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", withdrawalId)

      console.log(`[WITHDRAWAL-APPROVE] Processing: ${withdrawalId} — awaiting MoMo confirmation`)
      return NextResponse.json({
        success: true,
        status: "processing",
        message: "Transfer initiated. Awaiting mobile money confirmation.",
      })
    }

    // txstatus=2 (failed) or txstatus=3 (unknown)
    await supabase
      .from("withdrawal_requests")
      .update({
        transfer_attempted_at: null,
        moolre_external_ref: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", withdrawalId)

    console.error(`[WITHDRAWAL-APPROVE] Transfer failed: ${withdrawalId}, txstatus: ${result.txstatus}`)
    return NextResponse.json(
      { error: `Transfer failed (txstatus: ${result.txstatus}). Withdrawal remains pending.` },
      { status: 400 }
    )
  } catch (error) {
    console.error("[WITHDRAWAL-APPROVE] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
