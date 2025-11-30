import { supabase } from "@/lib/supabase"
import { NextRequest, NextResponse } from "next/server"

export async function GET(request: NextRequest) {
  try {
    // Get the user from the auth header
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

    // Get pending orders for this user from orders table (user dashboard orders)
    // Note: All pending bulk orders are already paid (wallet was deducted at creation)
    const { data: orders, error } = await supabase
      .from("orders")
      .select("id")
      .eq("user_id", user.id)
      .eq("status", "pending")

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
