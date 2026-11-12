
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import { gateAdmin } from "@/lib/admin-users/route-utils"
import { parseWalletAdjustBody, walletAdjustError } from "@/lib/admin-users/drawer-params"
import { sendPushToUser } from "@/lib/push-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)
/**
 * POST /api/admin/update-balance   { userId, type: "credit" | "debit", amount, reason, expectedBalance? }
 *
 * Admin wallet credit / debit. amount > 0 with at most 2 decimals (max 50000); reason 5-500 characters.
 * expectedBalance is the balance the admin confirmed; the change is refused (409) if it has moved since.
 * The wallet update, the transactions row (admin_credit / admin_debit) and the admin_audit_log row
 * (wallet_credit / wallet_debit, with the reason and before/after) are written in ONE transaction by
 * public.admin_wallet_adjust (migrations/0171), with the wallet row locked; a debit below 0 is refused (409).
 * The CRON_SECRET bypass is refused: every adjustment is attributed to the acting admin, and an admin cannot
 * adjust their own wallet (403, also enforced in the RPC).
 * Notifications (in-app, SMS, email, push) follow as before, best-effort.
 */
export async function POST(request: NextRequest) {
  const gate = await gateAdmin(request, { write: true })
  if (!gate.ok) return gate.response
  const adminUserId = gate.adminId!

  try {
    const body = await request.json().catch(() => null)
    const parsed = parseWalletAdjustBody(body)
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }
    const { userId, amount, type, reason, expectedBalance } = parsed.value
    if (userId === adminUserId) {
      return NextResponse.json({ error: "You cannot adjust your own wallet; ask another admin" }, { status: 403 })
    }

    const { data: result, error: rpcError } = await supabase.rpc("admin_wallet_adjust", {
      p_admin_id: adminUserId,
      p_user_id: userId,
      p_type: type,
      p_amount: amount,
      p_reason: reason,
      p_expected_balance: expectedBalance,
    })

    if (rpcError) {
      const mapped = walletAdjustError(rpcError.message, rpcError.details)
      if (mapped.status === 500) console.error("[ADMIN-BALANCE] admin_wallet_adjust failed:", rpcError.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    const balanceBefore = Number(result?.balance_before ?? 0)
    const newBalance = Number(result?.balance_after ?? 0)
    const reference: string = result?.reference_id ?? `ADMIN_${type.toUpperCase()}_${Date.now()}`
    console.log(`[ADMIN] ${type} of GHS ${amount.toFixed(2)} for ${userId} by ${adminUserId}: ${balanceBefore} -> ${newBalance}`)

    // Send notification to user about the balance update
    try {
      const notificationTitle = type === "credit"
        ? "Wallet Credited"
        : "Wallet Debited"

      const notificationMessage = type === "credit"
        ? `Your wallet has been credited with GHS ${amount.toFixed(2)} by admin. New balance: GHS ${newBalance.toFixed(2)}`
        : `Your wallet has been debited by GHS ${amount.toFixed(2)} by admin. New balance: GHS ${newBalance.toFixed(2)}`

      const notificationType: "balance_updated" | "admin_action" = "balance_updated"

      const { error: notifError } = await supabase
        .from("notifications")
        .insert([
          {
            user_id: userId,
            title: notificationTitle,
            message: notificationMessage,
            type: notificationType,
            reference_id: reference,
            action_url: "/dashboard/wallet",
            read: false,
          },
        ])

      if (notifError) {
        console.warn("[NOTIFICATION] Failed to send balance update notification:", notifError)
        // Don't fail the operation if notification fails
      } else {
        console.log(`[NOTIFICATION] Balance update notification sent to user ${userId}`)
      }
    } catch (notificationError) {
      console.warn("[NOTIFICATION] Error sending notification:", notificationError)
      // Don't fail the operation if notification fails
    }

    // Send SMS and Email to user about the balance update
    try {
      // Get user's phone number and email
      const { data: userProfile } = await supabase
        .from("users")
        .select("phone_number, email")
        .eq("id", userId)
        .single()

      if (userProfile?.phone_number) {
        const smsMessage = type === "credit"
          ? SMSTemplates.adminCredited(amount.toFixed(2), newBalance.toFixed(2))
          : SMSTemplates.adminDebited(amount.toFixed(2), newBalance.toFixed(2))

        await sendSMS({
          phone: userProfile.phone_number,
          message: smsMessage,
          type: type === "credit" ? "admin_credit" : "admin_debit",
          reference: reference,
          userId: userId,
        })

        console.log(`[SMS] Admin ${type} SMS sent to user ${userId}`)
      } else {
        console.warn(`[SMS] User ${userId} has no phone number, skipping SMS`)
      }

      // Send Email
      if (userProfile?.email) {
        const { sendEmail, EmailTemplates } = await import("@/lib/email-service")

        const emailPayload = type === "credit"
          ? EmailTemplates.walletTopUpSuccess(amount.toFixed(2), newBalance.toFixed(2), reference)
          : {
            subject: "Wallet Debited",
            html: `Your wallet has been debited GHS ${amount.toFixed(2)}. New Balance: GHS ${newBalance.toFixed(2)}`
          } // Fallback if no specific template for debit

        await sendEmail({
          to: [{ email: userProfile.email }],
          subject: emailPayload.subject,
          htmlContent: typeof emailPayload.html === 'string' ? emailPayload.html : (emailPayload as any).htmlContent || emailPayload.html, // Handle potential type mismatch if I didn't verify template generic return
          userId: userId,
          type: type === "credit" ? "admin_credit" : "admin_debit"
        })
        console.log(`[Email] Admin ${type} email sent to user ${userId}`)
      }

    } catch (notificationError) {
      console.warn("[NOTIFICATION] Error sending admin balance notification:", notificationError)
      // Don't fail the operation
    }

    // Push notification to user (non-blocking)
    sendPushToUser(userId, {
      title: type === 'credit' ? '💳 Wallet Credited' : '💳 Wallet Debited',
      body: type === 'credit'
        ? `GHS ${amount.toFixed(2)} has been added to your wallet. New balance: GHS ${newBalance.toFixed(2)}`
        : `GHS ${amount.toFixed(2)} has been deducted from your wallet. New balance: GHS ${newBalance.toFixed(2)}`,
      data: { url: '/dashboard/wallet' },
    }).catch(() => {})

    return NextResponse.json({
      success: true,
      balance: newBalance,
      data: {
        balance: newBalance,
        balanceBefore,
        transactionId: result?.transaction_id ?? null,
        referenceId: result?.reference_id ?? null,
      },
    })
  } catch (error: any) {
    console.error("Error in update-balance route:", error)
    return NextResponse.json(
      { error: error?.message || "Failed to update balance" },
      { status: 500 }
    )
  }
}
