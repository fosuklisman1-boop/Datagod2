import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  try {
    const { orderId } = await params

    if (!orderId) {
      return NextResponse.json(
        { error: "Order ID is required" },
        { status: 400 }
      )
    }

    console.log(`[SHOP-ORDER-GET] Fetching order details for ID: ${orderId}`)

    // Fetch the order using service role to bypass RLS
    const { data: order, error } = await supabase
      .from("shop_orders")
      .select("*")
      .eq("id", orderId)
      .single()

    if (error) {
      console.error("[SHOP-ORDER-GET] Database error:", error)
      if (error.code === "PGRST116") {
        return NextResponse.json(
          { error: "Order not found" },
          { status: 404 }
        )
      }
      throw new Error(`Failed to fetch order: ${error.message}`)
    }

    console.log(`[SHOP-ORDER-GET] ✓ Order found: ${order.reference_code}`)

    return NextResponse.json({
      success: true,
      order,
    })
  } catch (error) {
    console.error("[SHOP-ORDER-GET] ✗ Error:", error)
    return NextResponse.json(
      { error: "Failed to load order details. Please try again." },
      { status: 500 }
    )
  }
}
