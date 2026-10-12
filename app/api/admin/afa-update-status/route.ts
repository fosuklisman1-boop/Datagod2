import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { notifyUserOfOutcome } from "@/lib/admin-actions"
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
      .select("status, user_id, full_name, phone_number, order_code")
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

    // Notify the user (email + SMS to the registrant phone) on a real transition
    if (status !== currentOrder.status && (status === "completed" || status === "cancelled")) {
      await notifyUserOfOutcome(
        "afa",
        status === "completed" ? "completed" : "rejected",
        { userId: currentOrder.user_id, phone: currentOrder.phone_number, reference: submissionId },
        { orderCode: currentOrder.order_code, fullName: currentOrder.full_name },
      )
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
