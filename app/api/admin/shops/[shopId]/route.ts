import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

// Helper to fetch all records with pagination
async function fetchAllRecords(table: string, columns: string, filterColumn: string, filterValue: string) {
  let allRecords: any[] = []
  let offset = 0
  const batchSize = 1000
  let hasMore = true

  while (hasMore) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .eq(filterColumn, filterValue)
      .range(offset, offset + batchSize - 1)

    if (error) break

    if (data && data.length > 0) {
      allRecords = allRecords.concat(data)
      offset += batchSize
      hasMore = data.length === batchSize
    } else {
      hasMore = false
    }
  }

  return allRecords
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ shopId: string }> }
) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { shopId } = await params

    if (!shopId) {
      return NextResponse.json(
        { error: "Missing shopId" },
        { status: 400 }
      )
    }

    // Fetch shop details
    const { data: shop, error: shopError } = await supabase
      .from("user_shops")
      .select("id, shop_name, shop_slug, description, is_active, created_at, user_id")
      .eq("id", shopId)
      .single()

    if (shopError) {
      console.error("Error fetching shop:", shopError)
      return NextResponse.json(
        { error: shopError.message },
        { status: 500 }
      )
    }

    // Fetch recent orders (last 50), profits (last 50), and available balance
    const [ordersRes, profitsRes, balanceRes] = await Promise.all([
      supabase
        .from("shop_orders")
        .select("id, shop_id, customer_phone, network, volume_gb, transaction_id, order_status, payment_status, created_at")
        .eq("shop_id", shopId)
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("shop_profits")
        .select("id, shop_id, shop_order_id, profit_amount, status, created_at, notes, adjustment_type")
        .eq("shop_id", shopId)
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("shop_available_balance")
        .select("available_balance")
        .eq("shop_id", shopId)
        .maybeSingle()
    ])

    return NextResponse.json({
      success: true,
      data: {
        shop,
        orders: ordersRes.data || [],
        profits: profitsRes.data || [],
        available_balance: balanceRes.data?.available_balance || 0
      }
    })
  } catch (error: any) {
    console.error("Error in GET /api/admin/shops/[shopId]:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
