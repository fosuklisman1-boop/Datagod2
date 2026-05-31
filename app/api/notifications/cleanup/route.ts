import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

/**
 * Destructive cleanup: deletes notifications older than 72 hours.
 *
 * Authorized callers (any one):
 *   - Vercel Cron with Bearer ${CRON_SECRET}
 *   - Authenticated admin (DB role === "admin")
 *
 * Anonymous callers are rejected — previously this endpoint allowed anyone
 * to silently wipe notification history platform-wide.
 */
async function isAuthorized(request: NextRequest): Promise<boolean> {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) return false

  const token = authHeader.slice(7)

  // 1) Cron secret bypass
  if (process.env.CRON_SECRET && token === process.env.CRON_SECRET) return true

  // 2) Admin bypass — must be DB-verified, not just any logged-in user
  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey)
    const { data: { user } } = await supabase.auth.getUser(token)
    if (!user) return false
    const { data: profile } = await supabase
      .from("users")
      .select("role")
      .eq("id", user.id)
      .single()
    return profile?.role === "admin"
  } catch {
    return false
  }
}

async function handle(request: NextRequest) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    console.log("[NOTIFICATION-CLEANUP] Starting cleanup of old notifications...")
    const supabase = createClient(supabaseUrl, serviceRoleKey)
    const seventyTwoHoursAgo = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString()

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
    return NextResponse.json({ error: "Failed to cleanup notifications" }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  return handle(request)
}

export async function POST(request: NextRequest) {
  return handle(request)
}
