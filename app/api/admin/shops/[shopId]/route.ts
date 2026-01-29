import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

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

    // Fetch all orders and profits with pagination
    const [orders, profits] = await Promise.all([
      fetchAllRecords(
        "shop_orders",
        "id, shop_id, user_id, customer_phone, network, volume_gb, transaction_id, order_status, payment_status, created_at",
        "shop_id",
        shopId
      ),
      fetchAllRecords(
        "shop_profits",
        "id, shop_id, shop_order_id, profit_amount, status, created_at",
        "shop_id",
        shopId
      )
    ])

    return NextResponse.json({
      success: true,
      data: {
        shop,
        orders: orders || [],
        profits: profits || []
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
