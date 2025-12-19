import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { customerTrackingService } from "@/lib/customer-tracking-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(request: NextRequest) {
  try {
    // Verify user is authenticated
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userId = authHeader.slice(7)
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    console.log(`[CUSTOMER-ANALYTICS] Looking for shop with user_id: ${userId}`)

    // Get user's shop
    const { data: shop, error: shopError } = await supabase
      .from("shops")
      .select("*")
      .eq("user_id", userId)
      .single()

    console.log(`[CUSTOMER-ANALYTICS] Shop query error:`, shopError)
    console.log(`[CUSTOMER-ANALYTICS] Shop data:`, shop)

    if (!shop) {
      // Try to get ANY shop to see if the table is accessible
      const { data: testShops, error: testError } = await supabase
        .from("shops")
        .select("id, user_id, name")
        .limit(5)
      
      console.log(`[CUSTOMER-ANALYTICS] Test query - all shops:`, { testShops, testError })
      console.log(`[CUSTOMER-ANALYTICS] Looking for user_id match in shops. User ID: ${userId}`)
      if (testShops && testShops.length > 0) {
        testShops.forEach(s => {
          console.log(`[CUSTOMER-ANALYTICS] Shop: ${s.id}, name: ${s.name}, user_id: ${s.user_id}`)
        })
      }
      
      return NextResponse.json({ 
        error: "Shop not found",
        userId,
        debug: "Check server logs for detailed info"
      }, { status: 404 })
    }

    console.log(`[CUSTOMER-ANALYTICS] Found shop: ${shop.id}`)

    // Fetch customer stats
    const stats = await customerTrackingService.getCustomerStats(shop.id)

    return NextResponse.json({
      success: true,
      shop_id: shop.id,
      ...stats,
    })
  } catch (error) {
    console.error("[CUSTOMER-ANALYTICS] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
