import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

interface DeleteBatchesRequest {
  fromDate?: string // ISO date string
  toDate?: string // ISO date string
  batchIds?: string[] // Specific batch IDs to delete
}

/**
 * DELETE endpoint to delete download batches by date range or IDs
 * Requires admin authentication
 */
export async function POST(request: NextRequest) {
  try {
    // Get auth header
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Parse request body
    const body: DeleteBatchesRequest = await request.json()
    const { fromDate, toDate, batchIds } = body

    let query = supabase.from("order_download_batches").delete()

    // Delete by specific batch IDs
    if (batchIds && batchIds.length > 0) {
      const { data, error } = await query.in("id", batchIds).select("id")

      if (error) {
        console.error("[DELETE-BATCHES] Error deleting batches:", error)
        return NextResponse.json(
          { error: `Failed to delete batches: ${error.message}` },
          { status: 500 }
        )
      }

      const deletedCount = data?.length || 0
      console.log(`[DELETE-BATCHES] Deleted ${deletedCount} batches by ID`)

      return NextResponse.json({
        success: true,
        message: `Deleted ${deletedCount} batch(es)`,
        deletedCount,
      })
    }

    // Delete by date range
    if (fromDate && toDate) {
      const { data, error } = await query
        .gte("created_at", fromDate)
        .lte("created_at", toDate)
        .select("id")

      if (error) {
        console.error("[DELETE-BATCHES] Error deleting batches:", error)
        return NextResponse.json(
          { error: `Failed to delete batches: ${error.message}` },
          { status: 500 }
        )
      }

      const deletedCount = data?.length || 0
      console.log(`[DELETE-BATCHES] Deleted ${deletedCount} batches between ${fromDate} and ${toDate}`)

      return NextResponse.json({
        success: true,
        message: `Deleted ${deletedCount} batch(es) from ${fromDate} to ${toDate}`,
        deletedCount,
      })
    }

    // Delete only older than date (e.g., all before a certain date)
    if (fromDate) {
      const { data, error } = await query.lt("created_at", fromDate).select("id")

      if (error) {
        console.error("[DELETE-BATCHES] Error deleting batches:", error)
        return NextResponse.json(
          { error: `Failed to delete batches: ${error.message}` },
          { status: 500 }
        )
      }

      const deletedCount = data?.length || 0
      console.log(`[DELETE-BATCHES] Deleted ${deletedCount} batches older than ${fromDate}`)

      return NextResponse.json({
        success: true,
        message: `Deleted ${deletedCount} batch(es) older than ${fromDate}`,
        deletedCount,
      })
    }

    return NextResponse.json(
      { error: "Please provide either batchIds or a date range (fromDate, toDate, or just fromDate)" },
      { status: 400 }
    )
  } catch (error) {
    console.error("[DELETE-BATCHES] Error:", error)
    return NextResponse.json(
      { error: "Failed to delete batches" },
      { status: 500 }
    )
  }
}
