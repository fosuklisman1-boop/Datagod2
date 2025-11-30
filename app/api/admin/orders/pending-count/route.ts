import { supabase } from "@/lib/supabase"
import { NextRequest, NextResponse } from "next/server"

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization")
    
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    // Extract token from Bearer header
    const token = authHeader.slice(7)

    // Verify the token and get user
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    
    if (authError || !user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    // Check if user is admin
    const role = user.user_metadata?.role
    if (role !== "admin") {
      return NextResponse.json(
        { error: "Forbidden" },
        { status: 403 }
      )
    }

    // Get all pending orders (admin can see all)
    const { data: orders, error } = await supabase
      .from("shop_orders")
      .select("id")
      .eq("order_status", "pending")

    if (error) throw error

    return NextResponse.json({
      count: orders?.length || 0
    })
  } catch (error) {
    console.error("Error fetching admin pending orders count:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
