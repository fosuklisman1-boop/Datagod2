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
      console.log("[CUSTOMER-ANALYTICS] No auth header")
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userId = authHeader.slice(7)
    if (!userId) {
      console.log("[CUSTOMER-ANALYTICS] Empty user ID")
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    console.log(`[CUSTOMER-ANALYTICS] Fetching stats for user: ${userId}`)

    // Get user's shop
    const { data: shop, error: shopError } = await supabase
      .from("shops")
      .select("id")
      .eq("user_id", userId)
      .single()

    if (shopError) {
      console.error(`[CUSTOMER-ANALYTICS] Shop query error:`, shopError)
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    if (!shop) {
      console.log(`[CUSTOMER-ANALYTICS] No shop found for user ${userId}`)
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    console.log(`[CUSTOMER-ANALYTICS] Found shop: ${shop.id}`)

    // Fetch customer stats
    const stats = await customerTrackingService.getCustomerStats(shop.id)

    console.log(`[CUSTOMER-ANALYTICS] Stats computed:`, stats)

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
