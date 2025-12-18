import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const {
      shop_id,
      customer_email,
      customer_phone,
      customer_name,
      shop_package_id,
      package_id,
      network,
      volume_gb,
      base_price,
      profit_amount,
      total_price,
    } = body

    console.log("[SHOP-ORDER] Creating order for:", {
      shop_id,
      customer_email,
      network,
      total_price,
    })

    // Validate input
    if (!shop_id || !customer_email || !customer_phone || !shop_package_id) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      )
    }

    const { data, error } = await supabase
      .from("shop_orders")
      .insert([
        {
          shop_id,
          customer_email,
          customer_phone,
          customer_name: customer_name || "Guest",
          shop_package_id,
          package_id,
          network,
          volume_gb,
          base_price: parseFloat(base_price.toString()),
          profit_amount: parseFloat(profit_amount.toString()),
          total_price: parseFloat(total_price.toString()),
          order_status: "pending",
          payment_status: "pending",
          reference_code: `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`,
          created_at: new Date().toISOString(),
        },
      ])
      .select()

    if (error) {
      console.error("[SHOP-ORDER] Database error:", error)
      throw new Error(`Failed to create order: ${error.message}`)
    }

    if (!data || data.length === 0) {
      throw new Error("Failed to create order: No data returned")
    }

    console.log("[SHOP-ORDER] ✓ Order created:", data[0].id)

    // Send SMS to customer with order details
    try {
      const orderMessage = `DATAGOD: Order confirmed! ID: ${data[0].reference_code} | ${network} ${volume_gb}GB | GHS ${total_price} | Status: Pending payment`
      
      await sendSMS({
        phone: customer_phone,
        message: orderMessage,
        type: 'order_created',
        reference: data[0].id,
      }).catch(err => console.error("[SHOP-ORDER] SMS error:", err))
    } catch (smsError) {
      console.warn("[SHOP-ORDER] SMS notification failed:", smsError)
      // Continue anyway - don't fail the order if SMS fails
    }

    return NextResponse.json({
      success: true,
      order: data[0],
    })
  } catch (error) {
    console.error("[SHOP-ORDER] ✗ Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create order" },
      { status: 500 }
    )
  }
}
