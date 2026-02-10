
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)
export async function POST(request: NextRequest) {
  // Server-side admin check
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) {
    return errorResponse
  }

  try {
    const { shopId, amount, type } = await request.json()

    if (!shopId || amount === undefined || !type) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      )
    }

    // Get the user_id from the shop
    const { data: shop, error: shopError } = await supabase
      .from("user_shops")
      .select("user_id")
      .eq("id", shopId)
      .single()

    if (shopError || !shop) {
      return NextResponse.json(
        { error: "Shop not found" },
        { status: 404 }
      )
    }

    const userId = shop.user_id

    // Get current wallet balance (select only needed columns)
    const { data: wallet, error: walletError } = await supabase
      .from("wallets")
      .select("balance, total_credited, total_spent")
      .eq("user_id", userId)
      .maybeSingle()

    if (walletError) {
      console.error("Wallet fetch error:", walletError)
      return NextResponse.json(
        { error: "Failed to fetch wallet" },
        { status: 400 }
      )
    }

    if (!wallet) {
      return NextResponse.json(
        { error: "Wallet not found for user" },
        { status: 404 }
      )
    }

    const currentBalance = wallet.balance || 0
    const newBalance = type === "credit"
      ? currentBalance + amount
      : Math.max(0, currentBalance - amount)

    // Calculate updated total_credited and total_spent
    const currentTotalCredited = wallet.total_credited || 0
    const currentTotalSpent = wallet.total_spent || 0

    const newTotalCredited = type === "credit"
      ? currentTotalCredited + amount
      : currentTotalCredited

    const newTotalSpent = type === "debit"
      ? currentTotalSpent + amount
      : currentTotalSpent

    // Update wallet balance and totals
    const { data: updated, error: updateError } = await supabase
      .from("wallets")
      .update({
        balance: newBalance,
        total_credited: newTotalCredited,
        total_spent: newTotalSpent,
      })
      .eq("user_id", userId)
      .select()

    if (updateError) {
      console.error("Wallet update error:", updateError)
      return NextResponse.json(
        { error: `Failed to update wallet: ${updateError.message}` },
        { status: 400 }
      )
    }

    // Create transaction history record
    const transactionType = type === "credit" ? "admin_credit" : "admin_debit"
    const description = type === "credit"
      ? `Admin credited GHS ${amount.toFixed(2)}`
      : `Admin debited GHS ${amount.toFixed(2)}`

    const { error: transactionError } = await supabase
      .from("transactions")
      .insert([{
        user_id: userId,
        amount: amount,
        type: transactionType,
        status: "completed",
        description: description,
        reference_id: `ADMIN_${type.toUpperCase()}_${Date.now()}`,
        source: "admin_operation",
        balance_before: currentBalance,
        balance_after: newBalance,
        created_at: new Date().toISOString(),
      }])

    if (transactionError) {
      console.error("Error creating transaction record:", transactionError)
      // Log but don't fail - wallet was already updated successfully
    } else {
      console.log(`[ADMIN] Transaction record created for ${transactionType} of GHS ${amount.toFixed(2)}`)
    }

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
            reference_id: `ADMIN_${type.toUpperCase()}_${Date.now()}`,
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
          reference: `ADMIN_${type.toUpperCase()}_${Date.now()}`,
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
          ? EmailTemplates.walletTopUpSuccess(amount.toFixed(2), newBalance.toFixed(2), `ADMIN_${type.toUpperCase()}_${Date.now()}`)
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

    return NextResponse.json({
      success: true,
      data: updated?.[0]
    })
  } catch (error: any) {
    console.error("Error in update-balance route:", error)
    return NextResponse.json(
      { error: error?.message || "Failed to update balance" },
      { status: 500 }
    )
  }
}
