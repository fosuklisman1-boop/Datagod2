import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// Initialize Supabase with service role key
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  try {
    const { orderIds } = await request.json()

    if (!orderIds || orderIds.length === 0) {
      return NextResponse.json(
        { error: "No order IDs provided" },
        { status: 400 }
      )
    }

    console.log("[BATCH-STATUSES] Fetching current statuses for", orderIds.length, "orders")

    // Fetch from both tables to get current status
    const [bulkResult, shopResult] = await Promise.all([
      supabase
        .from("orders")
        .select("id, status")
        .in("id", orderIds),
      supabase
        .from("shop_orders")
        .select("id, order_status")
        .in("id", orderIds)
    ])

    if (bulkResult.error) {
      console.error("Error fetching bulk order statuses:", bulkResult.error)
      throw new Error(`Failed to fetch bulk order statuses: ${bulkResult.error.message}`)
    }

    if (shopResult.error) {
      console.error("Error fetching shop order statuses:", shopResult.error)
      throw new Error(`Failed to fetch shop order statuses: ${shopResult.error.message}`)
    }

    // Combine results into a map
    const statusMap: { [key: string]: string } = {}

    bulkResult.data?.forEach((order: any) => {
      statusMap[order.id] = order.status
    })

    shopResult.data?.forEach((order: any) => {
      statusMap[order.id] = order.order_status
    })

    console.log("[BATCH-STATUSES] Found statuses for", Object.keys(statusMap).length, "orders")

    return NextResponse.json({
      success: true,
      statusMap
    })
  } catch (error) {
    console.error("Error fetching batch statuses:", error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
        success: false
      },
      { status: 500 }
    )
  }
}
