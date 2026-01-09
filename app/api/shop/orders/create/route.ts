import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { isPhoneBlacklisted } from "@/lib/blacklist"
import { sendSMS } from "@/lib/sms-service"

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

    // NOTE: Customer tracking is now done AFTER payment is confirmed
    // This prevents inflated customer revenue from abandoned orders
    // See: Paystack webhook and wallet/debit route for customer tracking

    // Check if phone number is blacklisted
    let phoneQueue = "default"
    let orderStatus = "pending"
    try {
      const isBlacklisted = await isPhoneBlacklisted(customer_phone)
      if (isBlacklisted) {
        phoneQueue = "blacklisted"
        orderStatus = "blacklisted"
        console.log(`[SHOP-ORDER] Phone ${customer_phone} is blacklisted - setting queue to 'blacklisted' and order_status to 'blacklisted'`)
      }
    } catch (blacklistError) {
      console.warn("[SHOP-ORDER] Error checking blacklist:", blacklistError)
      // Continue with default queue if blacklist check fails
    }

    // Check if this shop has a parent shop (sub-agent scenario)
    let parent_shop_id: string | null = null
    let parent_profit_amount: number | null = null
    let finalShopPackageId = shop_package_id
    
    try {
      const { data: shopData, error: shopError } = await supabase
        .from("user_shops")
        .select("parent_shop_id")
        .eq("id", shop_id)
        .single()

      if (!shopError && shopData?.parent_shop_id) {
        parent_shop_id = shopData.parent_shop_id
        
        // For sub-agents, shop_package_id might be from sub_agent_shop_packages
        // We need to find the corresponding shop_packages entry or create one
        if (shop_package_id && package_id) {
          // Try to find if there's a shop_packages entry for this package
          const { data: shopPkg } = await supabase
            .from("shop_packages")
            .select("id")
            .eq("shop_id", shop_id)
            .eq("package_id", package_id)
            .single()
          
          if (shopPkg) {
            // Use the existing shop_packages ID
            finalShopPackageId = shopPkg.id
          } else {
            // Create a shop_packages entry for this sub-agent's package
            // Get the profit margin from sub_agent_shop_packages
            const { data: subAgentPkg } = await supabase
              .from("sub_agent_shop_packages")
              .select("sub_agent_profit_margin")
              .eq("id", shop_package_id)
              .single()
            
            const { data: newShopPkg, error: createError } = await supabase
              .from("shop_packages")
              .insert([{
                shop_id,
                package_id,
                profit_margin: subAgentPkg?.sub_agent_profit_margin || 0,
                is_available: true
              }])
              .select("id")
              .single()
            
            if (!createError && newShopPkg) {
              finalShopPackageId = newShopPkg.id
            } else {
              console.warn("[SHOP-ORDER] Could not create shop_packages entry for sub-agent")
              // Continue without mapping - order creation might fail if FK is enforced
            }
          }
        }
        
        // Calculate parent's profit: the wholesale_margin from sub_agent_catalog
        // Parent profit = wholesale_margin (what parent charges above admin price)
        // NOT base_price - admin_price (that's the sub-agent's total margin)
        console.log(`[SHOP-ORDER] Looking up catalog for parent_shop_id=${parent_shop_id}, package_id=${package_id}`)
        
        const { data: catalogEntry, error: catalogError } = await supabase
          .from("sub_agent_catalog")
          .select("wholesale_margin, parent_price")
          .eq("shop_id", parent_shop_id)
          .eq("package_id", package_id)
          .single()
        
        console.log(`[SHOP-ORDER] Catalog lookup result:`, { catalogEntry, catalogError })
        
        if (catalogEntry && catalogEntry.wholesale_margin !== null && catalogEntry.wholesale_margin !== undefined && catalogEntry.wholesale_margin > 0) {
          parent_profit_amount = catalogEntry.wholesale_margin
          console.log(`[SHOP-ORDER] Using wholesale_margin from catalog: ${parent_profit_amount}`)
        } else if (catalogEntry && catalogEntry.parent_price) {
          // If wholesale_margin is 0 but parent_price exists, calculate from parent_price
          const { data: packageData } = await supabase
            .from("packages")
            .select("price")
            .eq("id", package_id)
            .single()
          
          const adminPrice = packageData?.price || 0
          parent_profit_amount = catalogEntry.parent_price - adminPrice
          if (parent_profit_amount < 0) parent_profit_amount = 0
          console.log(`[SHOP-ORDER] Calculated from parent_price: parent_price(${catalogEntry.parent_price}) - adminPrice(${adminPrice}) = ${parent_profit_amount}`)
        } else {
          // Fallback: calculate from admin price if catalog entry not found
          const { data: packageData } = await supabase
            .from("packages")
            .select("price")
            .eq("id", package_id)
            .single()
          
          const adminPrice = packageData?.price || 0
          // Calculate: parent profit = what sub-agent pays (base_price) - admin price - sub-agent profit
          // Actually, for storefront orders: sub-agent sells at base_price + profit_amount
          // So parent profit = base_price - admin_price (the wholesale markup)
          parent_profit_amount = parseFloat(base_price.toString()) - adminPrice
          
          // Ensure it's not negative
          if (parent_profit_amount < 0) parent_profit_amount = 0
          
          console.warn(`[SHOP-ORDER] No catalog entry found, using fallback calculation: base_price(${base_price}) - adminPrice(${adminPrice}) = ${parent_profit_amount}`)
        }

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
          shop_package_id: finalShopPackageId,
          package_id,
          network,
          volume_gb,
          base_price: parseFloat(base_price.toString()),
          profit_amount: parseFloat(profit_amount.toString()),
          total_price: parseFloat(total_price.toString()),
          order_status: orderStatus,
          payment_status: "pending",
          reference_code: `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`,
          shop_customer_id: null, // Will be set when payment is confirmed
          parent_shop_id: parent_shop_id || null,
          parent_profit_amount: parent_profit_amount !== null ? parseFloat(parent_profit_amount.toString()) : 0,
          queue: phoneQueue,
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

    console.log("[SHOP-ORDER] ✓ Order created:", data[0].id, {
      parent_shop_id: data[0].parent_shop_id,
      parent_profit_amount: data[0].parent_profit_amount
    })

    // Send blacklist notification SMS if order was blacklisted
    if (orderStatus === "blacklisted") {
      try {
        const blacklistSMS = `DATAGOD: Your order for ${network} ${volume_gb}GB to ${customer_phone} has been created. However, this number is blacklisted and your order will not be fulfilled. Contact support for assistance.`
        await sendSMS({
          phone: customer_phone,
          message: blacklistSMS,
          type: 'order_blacklisted',
          reference: data[0].id,
        }).catch(err => console.error("[SHOP-ORDER] Blacklist SMS error:", err))
        console.log("[SHOP-ORDER] ✓ Blacklist notification SMS sent to", customer_phone)
      } catch (smsError) {
        console.warn("[SHOP-ORDER] Failed to send blacklist notification SMS:", smsError)
      }

      // Send admin notification
      try {
        const { data: shopOwner } = await supabase
          .from("users")
          .select("phone_number")
          .eq("id", (await supabase.from("user_shops").select("user_id").eq("id", shop_id).single()).data?.user_id)
          .single()

        if (shopOwner?.phone_number) {
          const adminSMS = `[ALERT] DATAGOD: Order ${data[0].id.substring(0, 8)} from blacklisted number ${customer_phone} attempted to place a ${network} order. Order blocked.`
          await sendSMS({
            phone: shopOwner.phone_number,
            message: adminSMS,
            type: 'admin_alert',
            reference: data[0].id,
          }).catch(err => console.error("[SHOP-ORDER] Admin SMS error:", err))
          console.log("[SHOP-ORDER] ✓ Admin alert SMS sent to", shopOwner.phone_number)
        }
      } catch (adminError) {
        console.warn("[SHOP-ORDER] Failed to send admin alert SMS:", adminError)
      }
    }

    return NextResponse.json({
      success: true,
      order: data[0],
    })
  } catch (error) {
    console.error("[SHOP-ORDER] ✗ Error:", error)
    return NextResponse.json(
      { error: "Failed to create order. Please try again." },
      { status: 500 }
    )
  }
}
