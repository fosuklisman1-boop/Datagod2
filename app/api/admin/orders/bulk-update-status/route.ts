import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// Initialize Supabase with service role key
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  try {
    const { orderIds, status } = await request.json()

    if (!orderIds || orderIds.length === 0) {
      return NextResponse.json(
        { error: "No order IDs provided" },
        { status: 400 }
      )
    }

    if (!status) {
      return NextResponse.json(
        { error: "Status is required" },
        { status: 400 }
      )
    }

    // Update order status
    const { error: updateError } = await supabase
      .from("orders")
      .update({ status })
      .in("id", orderIds)

    if (updateError) {
      throw new Error(`Failed to update order status: ${updateError.message}`)
    }

    console.log(`Updated ${orderIds.length} orders to status: ${status}`)

    return NextResponse.json({
      success: true,
      count: orderIds.length,
      status
    })
  } catch (error) {
    console.error("Error in bulk update status:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
