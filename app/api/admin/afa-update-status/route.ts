import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function POST(request: NextRequest) {
  try {
    // Get auth header
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const token = authHeader.substring(7)
    const supabase = createClient(supabaseUrl, serviceRoleKey)

    // Verify token and get user
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Check if user is admin via user_metadata (primary check)
    let isAdmin = user.user_metadata?.role === "admin"

    if (!isAdmin) {
      // Also check the users table as a fallback
      const { data: userData, error: userTableError } = await supabase
        .from("users")
        .select("role")
        .eq("id", user.id)
        .single()

      if (!userTableError && userData?.role === "admin") {
        isAdmin = true
      }
    }

    if (!isAdmin) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 })
    }

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
