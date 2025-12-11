import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Cache-Control": "public, s-maxage=0, stale-while-revalidate=0"
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ shopId: string }> }
) {
  try {
    const { shopId } = await params
    
    console.log('[SHOP-DETAILS-API] Fetching details for shop:', shopId)

    if (!shopId) {
      console.error('[SHOP-DETAILS-API] Missing shopId')
      return NextResponse.json(
        { error: "Missing shopId" },
        { status: 400, headers: corsHeaders }
      )
    }

    // Verify authorization
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      console.warn('[SHOP-DETAILS-API] Missing or invalid authorization for shop:', shopId)
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401, headers: corsHeaders }
      )
    }

    const token = authHeader.slice(7)
    const supabaseClient = createClient(supabaseUrl, serviceRoleKey)
    const { data: { user }, error: userError } = await supabaseClient.auth.getUser(token)

    if (userError || !user) {
      console.error('[SHOP-DETAILS-API] Invalid token for shop:', shopId)
      return NextResponse.json(
        { error: "Invalid token" },
        { status: 401, headers: corsHeaders }
      )
    }

    // Check if user is admin
    let isAdmin = user.user_metadata?.role === "admin"
    if (!isAdmin) {
      const { data: userData } = await supabaseClient
        .from("users")
        .select("role")
        .eq("id", user.id)
        .single()
      isAdmin = userData?.role === "admin"
    }

    if (!isAdmin) {
      console.warn('[SHOP-DETAILS-API] Non-admin user attempting access for shop:', shopId)
      return NextResponse.json(
        { error: "Admin access required" },
        { status: 403, headers: corsHeaders }
      )
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey)

    // Get shop details
    console.log('[SHOP-DETAILS-API] Querying shop from database:', shopId)
    const { data: shop, error: shopError } = await supabase
      .from("user_shops")
      .select("*")
      .eq("id", shopId)
      .single()

    if (shopError) {
      console.error('[SHOP-DETAILS-API] Error fetching shop:', shopId, shopError)
      return NextResponse.json(
        { error: shopError.message },
        { status: 500, headers: corsHeaders }
      )
    }

    // Get shop orders
    console.log('[SHOP-DETAILS-API] Querying orders for shop:', shopId)
    const { data: orders } = await supabase
      .from("shop_orders")
      .select("*")
      .eq("shop_id", shopId)

    // Get shop profits
    console.log('[SHOP-DETAILS-API] Querying profits for shop:', shopId)
    const { data: profits } = await supabase
      .from("shop_profits")
      .select("*")
      .eq("shop_id", shopId)

    console.log('[SHOP-DETAILS-API] Successfully fetched details for shop:', shopId, '- Orders:', orders?.length || 0, 'Profits:', profits?.length || 0)

    return NextResponse.json({
      success: true,
      data: {
        shop,
        orders: orders || [],
        profits: profits || []
      }
    }, { headers: corsHeaders })
  } catch (error: any) {
    console.error("[SHOP-DETAILS-API] Error in GET /api/admin/shops/[shopId]:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500, headers: corsHeaders }
    )
  }
}

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders })
}
