import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(request: NextRequest) {
  try {
    // Get auth header
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const token = authHeader.substring(7)

    // Verify token and get user
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Check if user is admin
    const { data: adminUser, error: adminError } = await supabase
      .from("users")
      .select("role")
      .eq("id", user.id)
      .single()

    if (adminError || !adminUser || adminUser.role !== "admin") {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 })
    }

    // Also check user_metadata for admin role
    if (user.user_metadata?.role !== "admin") {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 })
    }

    // Fetch all AFA orders with user email
    const { data: afaOrders, error: afaError } = await supabase
      .from("afa_orders")
      .select(`
        id,
        user_id,
        order_code,
        transaction_code,
        full_name,
        phone_number,
        gh_card_number,
        location,
        region,
        occupation,
        amount,
        status,
        created_at
      `)
      .order("created_at", { ascending: false })

    if (afaError) {
      console.error("Error fetching AFA orders:", afaError)
      return NextResponse.json(
        { error: "Failed to fetch submissions" },
        { status: 500 }
      )
    }

    // Get user emails for each order
    const submissionsWithEmails = await Promise.all(
      (afaOrders || []).map(async (order) => {
        const { data: { user: orderUser } } = await supabase.auth.admin.getUserById(
          order.user_id
        )
        return {
          ...order,
          user_email: orderUser?.email || "Unknown",
        }
      })
    )

    return NextResponse.json(
      {
        submissions: submissionsWithEmails,
      },
      { status: 200 }
    )
  } catch (error) {
    console.error("Error in admin AFA registrations:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
