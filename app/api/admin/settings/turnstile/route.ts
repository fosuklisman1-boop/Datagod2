import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { invalidateTurnstileCache } from "@/lib/turnstile"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * GET /api/admin/settings/turnstile
 * Returns current Turnstile enablement (defaults to enabled if no row).
 */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { data, error } = await supabase
      .from("admin_settings")
      .select("key, value, updated_at")
      .eq("key", "turnstile_enabled")
      .maybeSingle()

    if (error) {
      console.error("[TURNSTILE-SETTINGS] Read error:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Row missing = default to enabled (safe default — security is ON unless explicitly disabled)
    const enabled = data?.value?.enabled !== false
    return NextResponse.json({
      success: true,
      enabled,
      updated_at: data?.updated_at ?? null,
    })
  } catch (e) {
    console.error("[TURNSTILE-SETTINGS] GET error:", e)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

/**
 * POST /api/admin/settings/turnstile  { enabled: boolean }
 * Update Turnstile enablement. Invalidates the in-memory cache in lib/turnstile
 * so the change takes effect within seconds, not 30s of cache lifetime.
 */
export async function POST(request: NextRequest) {
  const { isAdmin, userId, userEmail, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const body = await request.json()
    const { enabled } = body

    if (typeof enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 })
    }

    const { error } = await supabase
      .from("admin_settings")
      .upsert({
        key: "turnstile_enabled",
        value: { enabled },
        description: "Master kill switch for Cloudflare Turnstile verification on shop order endpoints. Disable only during a Cloudflare outage or secret-rotation incident.",
        updated_at: new Date().toISOString(),
      }, { onConflict: "key" })

    if (error) {
      console.error("[TURNSTILE-SETTINGS] Upsert error:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    invalidateTurnstileCache()

    console.warn(`[TURNSTILE-SETTINGS] ⚠️ Turnstile is now ${enabled ? "ENABLED" : "DISABLED"} (by ${userEmail ?? userId})`)
    return NextResponse.json({
      success: true,
      enabled,
      message: `Turnstile verification is now ${enabled ? "ENABLED" : "DISABLED"}`,
    })
  } catch (e) {
    console.error("[TURNSTILE-SETTINGS] POST error:", e)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
