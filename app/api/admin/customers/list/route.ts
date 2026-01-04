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

    console.log(`[CUSTOMER-LIST] Looking for shop with user_id: ${userId}`)

    // Get user's shop (shops are in user_shops table, not shops table)
    const { data: shop, error: shopError } = await supabase
      .from("user_shops")
      .select("id")
      .eq("user_id", userId)
      .single()

    console.log(`[CUSTOMER-LIST] Shop query error:`, shopError)
    console.log(`[CUSTOMER-LIST] Shop data:`, shop)

    if (!shop) {
      // Try to get ANY shop to see if the table is accessible
      const { data: testShops, error: testError } = await supabase
        .from("user_shops")
        .select("id, user_id, shop_name")
        .limit(5)
      
      console.log(`[CUSTOMER-LIST] Test query - all shops:`, { testShops, testError })
      console.log(`[CUSTOMER-LIST] Looking for user_id match in shops. User ID: ${userId}`)
      if (testShops && testShops.length > 0) {
        testShops.forEach(s => {
          console.log(`[CUSTOMER-LIST] Shop: ${s.id}, shop_name: ${s.shop_name}, user_id: ${s.user_id}`)
        })
      }
      
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    // Get query params
    const { searchParams } = new URL(request.url)
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100)
    const offset = parseInt(searchParams.get("offset") || "0")

    // Fetch customers
    const result = await customerTrackingService.listCustomers(shop.id, limit, offset)

    return NextResponse.json({
      success: true,
      ...result,
    })
  } catch (error) {
    console.error("[CUSTOMER-LIST] Error:", error)
    return NextResponse.json(
      { error: "Failed to load customers. Please try again." },
      { status: 500 }
    )
  }
}
