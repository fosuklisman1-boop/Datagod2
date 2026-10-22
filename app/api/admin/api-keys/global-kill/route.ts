import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { summarizeKill, type KillStep } from "@/lib/api-v2/admin-actions"
import { disableV2, revokeAllV2Keys } from "@/lib/api-v2/store"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

/**
 * POST /api/admin/api-keys/global-kill
 * Admin: Instantly disable all API keys globally (v1 keys, v2 keys) and turn the v2 API off.
 * The three steps are attempted independently; one failing never skips the others.
 */
export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  console.log("[ADMIN API KEYS] Triggered GLOBAL KILL switch")

  let v1: KillStep
  try {
    const { error } = await supabase
      .from("user_api_keys")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .neq("is_active", false)
    if (error) {
      console.error("[ADMIN API KEYS] Global kill v1 error:", error)
      v1 = { ok: false }
    } else {
      v1 = { ok: true }
    }
  } catch (e) {
    console.error("[ADMIN API KEYS] Global kill v1 error:", e)
    v1 = { ok: false }
  }

  let v2Keys: KillStep
  try {
    v2Keys = { ok: true, count: await revokeAllV2Keys(supabase) }
  } catch (e) {
    console.error("[ADMIN API KEYS] Global kill v2 key revoke error:", e)
    v2Keys = { ok: false }
  }

  let v2Config: KillStep
  try {
    await disableV2(supabase)
    v2Config = { ok: true }
  } catch (e) {
    console.error("[ADMIN API KEYS] Global kill v2 config disable error:", e)
    v2Config = { ok: false }
  }

  const summary = summarizeKill({ v1, v2Keys, v2Config })
  if (summary.status !== 200) {
    return NextResponse.json({ error: summary.body.message, ...summary.body }, { status: summary.status })
  }
  return NextResponse.json(summary.body)
}
