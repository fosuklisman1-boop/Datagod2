import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { notificationTemplates } from "@/lib/notification-service"
import { sendSMS } from "@/lib/sms-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  try {
    const { shopId } = await request.json()

    if (!shopId) {
      return NextResponse.json(
        { error: "Missing shopId" },
        { status: 400 }
      )
    }

    // Update shop to active
    const { data, error } = await supabase
      .from("user_shops")
      .update({
        is_active: true,
        updated_at: new Date().toISOString()
      })
      .eq("id", shopId)
      .select("*, user_id")

    if (error) {
      console.error("Error approving shop:", error)
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      )
    }

    console.log(`Shop ${shopId} approved by admin`)

    // Send notification to shop owner
    if (data && data[0]) {
      try {
        const shop = data[0]
        const notificationData = notificationTemplates.shopApproved(shop.shop_name || "Your shop", shopId)
        const { error: notifError } = await supabase
          .from("notifications")
          .insert([
            {
              user_id: shop.user_id,
              title: notificationData.title,
              message: notificationData.message,
              type: notificationData.type,
              reference_id: notificationData.reference_id,
              action_url: `/dashboard/my-shop`,
              read: false,
            },
          ])
        if (notifError) {
          console.warn("[NOTIFICATION] Failed to send notification:", notifError)
        } else {
          console.log(`[NOTIFICATION] Shop approval notification sent to user ${shop.user_id}`)
        }
      } catch (notifError) {
        console.warn("[NOTIFICATION] Failed to send notification:", notifError)
        // Don't fail the approval if notification fails
      }

      // Send SMS to shop owner
      try {
        const shop = data[0]
        const { data: userData, error: userError } = await supabase
          .from("users")
          .select("phone_number")
          .eq("id", shop.user_id)
          .single()

        if (!userError && userData?.phone_number) {
          const smsMessage = `🎉 Congratulations! Your shop "${shop.shop_name}" has been approved. You can now start selling. Visit: www.datagod.store`
          
          await sendSMS({
            phone: userData.phone_number,
            message: smsMessage,
            type: 'shop_approved',
            reference: shopId,
          }).catch(err => console.error("[SMS] SMS error:", err))
        }
      } catch (smsError) {
        console.warn("[SMS] Failed to send shop approval SMS:", smsError)
        // Don't fail the approval if SMS fails
      }
    }

    return NextResponse.json({
      success: true,
      data: data[0]
    })
  } catch (error: any) {
    console.error("Error in POST /api/admin/shops/approve:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
