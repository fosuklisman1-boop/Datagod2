import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

/**
 * POST /api/admin/api-keys/global-kill
 * Admin: Instantly disable all API keys globally.
 */
export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  console.log("[ADMIN API KEYS] Triggered GLOBAL KILL switch")

  const { error } = await supabase
    .from("user_api_keys")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .neq("is_active", false)

  if (error) {
    console.error("[ADMIN API KEYS] Global kill error:", error)
    return NextResponse.json({ error: "Failed to disable all API keys" }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    message: "All API keys have been disabled successfully."
  })
}
