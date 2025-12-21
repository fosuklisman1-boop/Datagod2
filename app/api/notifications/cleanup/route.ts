import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

/**
 * API endpoint to cleanup notifications older than 72 hours
 * Called automatically when admin loads dashboard or can be triggered manually
 */
export async function GET() {
  try {
    console.log("[NOTIFICATION-CLEANUP] Starting cleanup of old notifications...")

    const supabase = createClient(supabaseUrl, serviceRoleKey)
    const seventyTwoHoursAgo = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString()

    // Delete notifications older than 72 hours
    const { data, error } = await supabase
      .from("notifications")
      .delete()
      .lt("created_at", seventyTwoHoursAgo)
      .select("id")

    if (error) {
      console.error("[NOTIFICATION-CLEANUP] Error:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const deletedCount = data?.length || 0
    console.log(`[NOTIFICATION-CLEANUP] Deleted ${deletedCount} old notifications`)

    return NextResponse.json({
      success: true,
      message: `Deleted ${deletedCount} notifications older than 72 hours`,
      deleted: deletedCount,
    })
  } catch (error) {
    console.error("[NOTIFICATION-CLEANUP] Error:", error)
    return NextResponse.json(
      { error: "Failed to cleanup notifications" },
      { status: 500 }
    )
  }
}

export async function POST() {
  return GET()
}
