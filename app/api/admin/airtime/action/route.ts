import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { sendSMS } from "@/lib/sms-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  try {
    // Auth — admin only
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const token = authHeader.slice(7)
    const { data: { user: admin }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !admin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    if (admin.user_metadata?.role !== "admin") {
      return NextResponse.json({ error: "Forbidden: Admin access required" }, { status: 403 })
    }

    const { orderId, action, notes } = await request.json()
    if (!orderId || !["completed", "failed"].includes(action)) {
      return NextResponse.json({ error: "orderId and action (completed|failed) are required" }, { status: 400 })
    }

    // Fetch the order
    const { data: order, error: fetchError } = await supabase
      .from("airtime_orders")
      .select("*, users(email)")
      .eq("id", orderId)
      .single()

    if (fetchError || !order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 })
    }

    if (order.status === "completed" || order.status === "failed") {
      return NextResponse.json({ error: `Order is already ${order.status}` }, { status: 409 })
    }

    // Update the order status
    const { error: updateError } = await supabase
      .from("airtime_orders")
      .update({ status: action, notes: notes || null, updated_at: new Date().toISOString() })
      .eq("id", orderId)

    if (updateError) throw updateError

    // If FAILED → refund the wallet
    if (action === "failed") {
      // Re-credit wallet
      const { data: wallet } = await supabase
        .from("wallets")
        .select("balance, total_spent")
        .eq("user_id", order.user_id)
        .single()

      if (wallet) {
        const newBalance = (wallet.balance || 0) + order.total_paid
        const newTotalSpent = Math.max(0, (wallet.total_spent || 0) - order.total_paid)

        await supabase
          .from("wallets")
          .update({ balance: newBalance, total_spent: newTotalSpent, updated_at: new Date().toISOString() })
          .eq("user_id", order.user_id)

        // Ledger entry for the refund
        await supabase.from("transactions").insert([{
          user_id: order.user_id,
          type: "credit",
          source: "airtime_refund",
          amount: order.total_paid,
          balance_before: wallet.balance,
          balance_after: newBalance,
          description: `Airtime refund: ${order.reference_code} — ${order.network} to ${order.beneficiary_phone}`,
          reference_id: order.id,
          status: "completed",
          created_at: new Date().toISOString(),
        }])
      }

      // Notify user of refund
      await supabase.from("notifications").insert([{
        user_id: order.user_id,
        title: "Airtime Order Failed — Refunded",
        message: `Your airtime order ${order.reference_code} could not be fulfilled. GHS ${order.total_paid} has been refunded to your wallet.`,
        type: "order_update",
        reference_id: order.id,
        action_url: `/dashboard/airtime`,
        read: false,
      }])

      // Non-blocking SMS to user
      sendSMS({
        phone: order.beneficiary_phone,
        message: `Your airtime order ${order.reference_code} failed. GHS ${order.total_paid} has been refunded to your wallet.`,
        type: "airtime_failed",
        reference: order.id,
      }).catch(e => console.warn("[AIRTIME-ACTION] Refund SMS error:", e))

      // Non-blocking email to user
      import("@/lib/email-service").then(({ sendEmail, EmailTemplates }) => {
        const p = EmailTemplates.airtimeOrderFailed(order.reference_code, notes || "Order could not be fulfilled")
        if (order.users?.email) {
          return sendEmail({
            to: [{ email: order.users.email }],
            subject: p.subject,
            htmlContent: p.html,
            referenceId: order.id,
            type: "airtime_failed",
          })
        }
      }).catch(e => console.warn("[AIRTIME-ACTION] Refund email error:", e))
    }

    // If COMPLETED → notify user of delivery
    if (action === "completed") {
      await supabase.from("notifications").insert([{
        user_id: order.user_id,
        title: "Airtime Delivered!",
        message: `GHS ${order.airtime_amount} ${order.network} airtime has been sent to ${order.beneficiary_phone}. Ref: ${order.reference_code}`,
        type: "order_update",
        reference_id: order.id,
        action_url: `/dashboard/airtime`,
        read: false,
      }])

      sendSMS({
        phone: order.beneficiary_phone,
        message: `GHS ${order.airtime_amount} ${order.network} airtime has been sent to ${order.beneficiary_phone}. Ref: ${order.reference_code}.`,
        type: "airtime_completed",
        reference: order.id,
      }).catch(e => console.warn("[AIRTIME-ACTION] Delivered SMS error:", e))

      import("@/lib/email-service").then(({ sendEmail, EmailTemplates }) => {
        const p = EmailTemplates.airtimePurchaseConfirmed(order.reference_code, order.network, order.airtime_amount.toFixed(2), order.total_paid.toFixed(2))
        if (order.users?.email) {
          return sendEmail({
            to: [{ email: order.users.email }],
            subject: p.subject,
            htmlContent: p.html,
            referenceId: order.id,
            type: "airtime_completed",
          })
        }
      }).catch(e => console.warn("[AIRTIME-ACTION] Delivered email error:", e))
    }

    console.log(`[AIRTIME-ACTION] Admin ${admin.id} marked order ${order.reference_code} as ${action}`)

    return NextResponse.json({ success: true, action, orderId })
  } catch (error) {
    console.error("[AIRTIME-ACTION] Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
