import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { customerTrackingService } from "@/lib/customer-tracking-service"

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
      shop_slug,
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

    // Track customer BEFORE creating order
    let shop_customer_id: string | undefined
    try {
      const trackingResult = await customerTrackingService.trackCustomer({
        shopId: shop_id,
        phoneNumber: customer_phone,
        email: customer_email,
        customerName: customer_name || "Guest",
        totalPrice: parseFloat(total_price.toString()),
        slug: shop_slug || "storefront",
      })
      shop_customer_id = trackingResult.customerId
      console.log(`[SHOP-ORDER] Customer tracked: ${shop_customer_id}, Repeat: ${trackingResult.isRepeatCustomer}`)
    } catch (trackingError) {
      console.error('[SHOP-ORDER] Customer tracking error (non-blocking):', trackingError)
      // Continue without tracking if it fails - order should still be created
    }

    // Check if this shop has a parent shop (sub-agent scenario)
    let parent_shop_id: string | null = null
    let parent_profit_amount: number | null = null
    
    try {
      const { data: shopData, error: shopError } = await supabase
        .from("user_shops")
        .select("parent_shop_id")
        .eq("id", shop_id)
        .single()

      if (!shopError && shopData?.parent_shop_id) {
        parent_shop_id = shopData.parent_shop_id
        
        // Calculate parent's profit: base_price for this order is what the sub-agent pays (parent's selling price)
        // The parent's profit is the difference between what sub-agent pays and the actual admin base price
        // For simplicity, we store the base_price the sub-agent uses as parent_profit_amount
        // This represents what the parent shop earns from this sale
        parent_profit_amount = parseFloat(base_price.toString())
        
        console.log(`[SHOP-ORDER] Sub-agent sale detected. Parent shop: ${parent_shop_id}, Parent profit: ${parent_profit_amount}`)
      }
    } catch (parentError) {
      console.warn("[SHOP-ORDER] Error checking for parent shop:", parentError)
      // Continue without parent - profit will only go to sub-agent
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
          shop_customer_id: shop_customer_id || null,
          parent_shop_id: parent_shop_id,
          parent_profit_amount: parent_profit_amount,
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

    // Create tracking record after order is created
    if (shop_customer_id) {
      try {
        await customerTrackingService.createTrackingRecord(
          shop_id,
          data[0].id,
          shop_customer_id,
          shop_slug || "storefront"
        )
        console.log(`[SHOP-ORDER] Tracking record created for order ${data[0].id}`)
      } catch (trackingError) {
        console.error('[SHOP-ORDER] Tracking record creation error (non-blocking):', trackingError)
      }
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
