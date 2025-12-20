import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(request: NextRequest) {
  return NextResponse.json(
    {
      status: "ok",
      message: "Test endpoint is working",
      url: "/api/test/fulfillment-logs-insert",
      method: "POST",
      usage: "Send POST request with order_id, network, phone_number",
    },
    { status: 200 }
  )
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    let { order_id, network, phone_number, status, error_message } = body

    console.log("[TEST-INSERT] Testing fulfillment_logs insert with:")
    console.log("[TEST-INSERT] order_id:", order_id)
    console.log("[TEST-INSERT] network:", network)
    console.log("[TEST-INSERT] phone_number:", phone_number)
    console.log("[TEST-INSERT] status:", status)

    // If order_id not provided, fetch a real order from the database
    if (!order_id) {
      console.log("[TEST-INSERT] No order_id provided, fetching a real order from orders table...")
      const { data: realOrder, error: fetchError } = await supabase
        .from("orders")
        .select("id")
        .limit(1)
        .single()

      if (fetchError || !realOrder) {
        return NextResponse.json(
          {
            success: false,
            error: "No orders found in database. Please provide order_id or create an order first.",
            hint: "Use the order UUID from the orders table",
          },
          { status: 400 }
        )
      }
      order_id = realOrder.id
      console.log("[TEST-INSERT] Using order_id from database:", order_id)
    }

    // Validate required fields
    if (!network || !phone_number) {
      return NextResponse.json(
        { error: "Missing required fields: network, phone_number" },
        { status: 400 }
      )
    }

    // Build the test record
    const testRecord = {
      order_id,
      network,
      phone_number,
      status: status || "test",
      error_message: error_message || null,
      api_response: { test: true, timestamp: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    }

    console.log("[TEST-INSERT] Attempting insert with record:", testRecord)

    // Try to insert
    const { data, error } = await supabase
      .from("fulfillment_logs")
      .insert([testRecord])
      .select()

    if (error) {
      console.error("[TEST-INSERT] ❌ Insert failed!")
      console.error("[TEST-INSERT] Error code:", error.code)
      console.error("[TEST-INSERT] Error message:", error.message)
      console.error("[TEST-INSERT] Error details:", JSON.stringify(error, null, 2))

      return NextResponse.json(
        {
          success: false,
          error: error.message,
          code: error.code,
          details: error,
        },
        { status: 400 }
      )
    }

    console.log("[TEST-INSERT] ✅ Insert successful!")
    console.log("[TEST-INSERT] Inserted record:", data)

    return NextResponse.json(
      {
        success: true,
        message: "Test insert successful",
        data,
      },
      { status: 201 }
    )
  } catch (error) {
    console.error("[TEST-INSERT] Exception:", error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}
