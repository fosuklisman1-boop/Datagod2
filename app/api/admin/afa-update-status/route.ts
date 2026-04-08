import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey)
    // Get request body
    const body = await request.json()
    const { submissionId, status } = body

    if (!submissionId || !status) {
      return NextResponse.json(
        { error: "Missing required fields: submissionId, status" },
        { status: 400 }
      )
    }

    // Validate status
    const validStatuses = ["pending", "processing", "completed", "cancelled"]
    if (!validStatuses.includes(status)) {
      return NextResponse.json(
        { error: "Invalid status. Must be one of: pending, processing, completed, cancelled" },
        { status: 400 }
      )
    }

    // Fetch existing order to check current status and get details for SMS
    const { data: currentOrder, error: fetchError } = await supabase
      .from("afa_orders")
      .select("status, full_name, phone_number, order_code")
      .eq("id", submissionId)
      .single()

    if (fetchError || !currentOrder) {
      return NextResponse.json(
        { error: "AFA order not found" },
        { status: 404 }
      )
    }

    // Update the AFA order status
    const { error: updateError } = await supabase
      .from("afa_orders")
      .update({
        status,
        updated_at: new Date().toISOString(),
      })
      .eq("id", submissionId)

    if (updateError) {
      console.error("[AFA-UPDATE-STATUS] Error updating status:", updateError)
      return NextResponse.json(
        { error: "Failed to update status" },
        { status: 500 }
      )
    }

    // If status changed to completed, send the completion SMS
    if (status === "completed" && currentOrder.status !== "completed") {
      try {
        await sendSMS({
          phone: currentOrder.phone_number,
          message: SMSTemplates.afaCompleted(currentOrder.full_name, currentOrder.order_code),
          type: "afa_completed",
        })
        console.log(`[AFA-UPDATE-STATUS] Completion SMS sent for order ${currentOrder.order_code}`)
      } catch (smsError) {
        console.error("[AFA-UPDATE-STATUS] Failed to send completion SMS:", smsError)
      }
    }

    return NextResponse.json(
      {
        success: true,
        message: "Status updated successfully",
      },
      { status: 200 }
    )
  } catch (error) {
    console.error("[AFA-UPDATE-STATUS] Error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
