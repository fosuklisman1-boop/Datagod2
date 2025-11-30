import { supabase } from "@/lib/supabase"
import { NextRequest, NextResponse } from "next/server"

export async function GET(request: NextRequest) {
  try {
    // Get the user from the auth header
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      // If no auth header, try to get session from Supabase
      const { data: { session } } = await supabase.auth.getSession()
      
      if (!session?.user) {
        return NextResponse.json(
          { error: "Unauthorized" },
          { status: 401 }
        )
      }

      // Get pending orders for this user
      const { data: orders, error } = await supabase
        .from("shop_orders")
        .select("id")
        .eq("user_id", session.user.id)
        .eq("order_status", "pending")

      if (error) throw error

      return NextResponse.json({
        count: orders?.length || 0
      })
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

    // Get pending orders for this user
    const { data: orders, error } = await supabase
      .from("shop_orders")
      .select("id")
      .eq("user_id", user.id)
      .eq("order_status", "pending")

    if (error) throw error

    return NextResponse.json({
      count: orders?.length || 0
    })
  } catch (error) {
    console.error("Error fetching pending orders count:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
