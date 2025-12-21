import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

/**
 * API endpoint to cleanup completed download batches older than 14 days
 * Called automatically when admin loads dashboard
 */
export async function GET() {
  try {
    console.log("[BATCH-CLEANUP] Starting cleanup of old completed batches...")

    const supabase = createClient(supabaseUrl, serviceRoleKey)
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()

    // Delete completed batches older than 14 days
    const { data, error } = await supabase
      .from("order_download_batches")
      .delete()
      .eq("status", "completed")
      .lt("created_at", fourteenDaysAgo)
      .select("id")

    if (error) {
      console.error("[BATCH-CLEANUP] Error:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const deletedCount = data?.length || 0
    console.log(`[BATCH-CLEANUP] Deleted ${deletedCount} old completed batches`)

    return NextResponse.json({
      success: true,
      message: `Deleted ${deletedCount} completed batches older than 14 days`,
      deleted: deletedCount,
    })
  } catch (error) {
    console.error("[BATCH-CLEANUP] Error:", error)
    return NextResponse.json(
      { error: "Failed to cleanup batches" },
      { status: 500 }
    )
  }
}

export async function POST() {
  return GET()
}
