import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { notificationTemplates } from "@/lib/notification-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  try {
    const { shopId, reason } = await request.json()

    if (!shopId) {
      return NextResponse.json(
        { error: "Missing shopId" },
        { status: 400 }
      )
    }

    // Update shop to inactive (rejected)
    const { data, error } = await supabase
      .from("user_shops")
      .update({
        is_active: false,
        updated_at: new Date().toISOString()
      })
      .eq("id", shopId)
      .select("*, user_id")

    if (error) {
      console.error("Error rejecting shop:", error)
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      )
    }

    console.log(`Shop ${shopId} rejected by admin`)

    // Send notification to shop owner
    if (data && data[0]) {
      try {
        const shop = data[0]
        const notificationData = notificationTemplates.shopRejected(shop.shop_name || "Your shop", shopId, reason)
        const { error: notifError } = await supabase
          .from("notifications")
          .insert([
            {
              user_id: shop.user_id,
              title: notificationData.title,
              message: notificationData.message,
              type: notificationData.type,
              metadata: {
                reference_id: notificationData.reference_id,
                action_url: `/dashboard/my-shop`,
              },
              is_read: false,
              created_at: new Date().toISOString(),
            },
          ])
        if (notifError) {
          console.warn("[NOTIFICATION] Failed to send notification:", notifError)
        } else {
          console.log(`[NOTIFICATION] Shop rejection notification sent to user ${shop.user_id}`)
        }
      } catch (notifError) {
        console.warn("[NOTIFICATION] Failed to send notification:", notifError)
        // Don't fail the rejection if notification fails
      }
    }

    return NextResponse.json({
      success: true,
      data: data[0]
    })
  } catch (error: any) {
    console.error("Error in POST /api/admin/shops/reject:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
