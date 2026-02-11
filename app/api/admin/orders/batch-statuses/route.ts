import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// Initialize Supabase with service role key
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

// Chunk size for batch queries (Supabase/PostgreSQL has limits on IN clause size)
const CHUNK_SIZE = 500

/**
 * Helper function to chunk an array into smaller arrays
 */
function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize))
  }
  return chunks
}

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

    // Split order IDs into chunks to avoid query limits
    const orderIdChunks = chunkArray(orderIds, CHUNK_SIZE)
    console.log(`[BATCH-STATUSES] Split into ${orderIdChunks.length} chunks of max ${CHUNK_SIZE} orders`)

    const statusMap: { [key: string]: string } = {}

    // Process each chunk
    for (let i = 0; i < orderIdChunks.length; i++) {
      const chunk = orderIdChunks[i]
      console.log(`[BATCH-STATUSES] Processing chunk ${i + 1}/${orderIdChunks.length} (${chunk.length} orders)`)

      // Fetch from both tables to get current status for this chunk
      const [bulkResult, shopResult] = await Promise.all([
        supabase
          .from("orders")
          .select("id, status")
          .in("id", chunk),
        supabase
          .from("shop_orders")
          .select("id, order_status")
          .in("id", chunk)
      ])

      if (bulkResult.error) {
        console.error(`[BATCH-STATUSES] Error fetching bulk order statuses (chunk ${i + 1}):`, bulkResult.error)
        throw new Error(`Failed to fetch bulk order statuses: ${bulkResult.error.message || 'Unknown error'}`)
      }

      if (shopResult.error) {
        console.error(`[BATCH-STATUSES] Error fetching shop order statuses (chunk ${i + 1}):`, shopResult.error)
        throw new Error(`Failed to fetch shop order statuses: ${shopResult.error.message || 'Unknown error'}`)
      }

      // Add results to status map
      bulkResult.data?.forEach((order: any) => {
        statusMap[order.id] = order.status
      })

      shopResult.data?.forEach((order: any) => {
        statusMap[order.id] = order.order_status
      })
    }

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
