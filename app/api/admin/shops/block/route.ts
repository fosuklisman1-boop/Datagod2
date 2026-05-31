import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { notificationTemplates } from "@/lib/notification-service"
import { sendSMS } from "@/lib/sms-service"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { sendPushToUser } from "@/lib/push-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { shopId, action, reason } = await request.json()

    if (!shopId || !action || !["block", "unblock"].includes(action)) {
      return NextResponse.json(
        { error: "Missing or invalid parameters. Provide shopId and action ('block' or 'unblock')" },
        { status: 400 }
      )
    }

    if (action === "block" && !reason?.trim()) {
      return NextResponse.json(
        { error: "A reason is required when blocking a shop" },
        { status: 400 }
      )
    }

    const isBlocking = action === "block"

    const { data, error } = await supabase
      .from("user_shops")
      .update({
        is_blocked: isBlocking,
        block_reason: isBlocking ? reason.trim() : null,
        blocked_at: isBlocking ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", shopId)
      .select("id, shop_name, user_id, is_blocked")
      .single()

    if (error) {
      console.error(`[ADMIN-SHOPS] Error ${action}ing shop:`, error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    console.log(`[ADMIN-SHOPS] Shop ${shopId} ${action}ed by admin`)

    // Notify shop owner
    if (data) {
      try {
        const notifData = isBlocking
          ? notificationTemplates.shopBlocked(data.shop_name, shopId, reason.trim())
          : notificationTemplates.shopUnblocked(data.shop_name, shopId)

        await supabase.from("notifications").insert([
          {
            user_id: data.user_id,
            title: notifData.title,
            message: notifData.message,
            type: notifData.type,
            reference_id: notifData.reference_id,
            action_url: "/dashboard/my-shop",
            read: false,
          },
        ])

        sendPushToUser(data.user_id, {
          title: notifData.title,
          body: notifData.message,
          data: { url: "/dashboard/my-shop" },
        }).catch(() => {})
      } catch {
        // Don't fail the action if notification fails
      }

      // SMS notification
      try {
        const { data: userData } = await supabase
          .from("users")
          .select("phone_number")
          .eq("id", data.user_id)
          .single()

        if (userData?.phone_number) {
          const smsMessage = isBlocking
            ? `DTGOD: Your shop "${data.shop_name}" has been temporarily blocked. Reason: ${reason.trim()}. Contact support for more info.`
            : `DTGOD: Your shop "${data.shop_name}" has been unblocked and is now active again.`

          await sendSMS({
            phone: userData.phone_number,
            message: smsMessage,
            type: isBlocking ? "shop_blocked" : "shop_unblocked",
            reference: shopId,
          }).catch(() => {})
        }
      } catch {
        // Don't fail the action if SMS fails
      }
    }

    return NextResponse.json({ success: true, data })
  } catch (error: any) {
    console.error(`[ADMIN-SHOPS] Error in POST /api/admin/shops/block:`, error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
