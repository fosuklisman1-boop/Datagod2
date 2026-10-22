import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getAdminClient } from "@/lib/api-v2/store"
import { parseConfigUpdate } from "@/lib/api-v2/lifecycle"

function shape(data: { enabled?: unknown; allowed_roles?: unknown }) {
  return {
    enabled: data.enabled === true,
    allowed_roles: Array.isArray(data.allowed_roles) ? data.allowed_roles : [],
  }
}

/** GET /api/admin/api-v2/config - Admin: read v2 API config. */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const supabase = getAdminClient()
  const { data, error } = await supabase
    .from("api_v2_config")
    .select("enabled, allowed_roles")
    .eq("id", true)
    .maybeSingle()
  if (error || !data) {
    console.error("[ADMIN API V2] Config read error:", error)
    return NextResponse.json({ error: "Failed to read API config" }, { status: 500 })
  }
  return NextResponse.json(shape(data))
}

/** PUT /api/admin/api-v2/config - Admin: update enabled / allowed_roles. */
export async function PUT(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const parsed = parseConfigUpdate(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const update: Record<string, unknown> = { ...parsed.value, updated_at: new Date().toISOString() }
  if (userId) update.updated_by = userId

  const supabase = getAdminClient()
  const { data, error } = await supabase
    .from("api_v2_config")
    .update(update)
    .eq("id", true)
    .select("enabled, allowed_roles")
    .maybeSingle()
  if (error || !data) {
    console.error("[ADMIN API V2] Config update error:", error)
    return NextResponse.json({ error: "Failed to update API config" }, { status: 500 })
  }
  return NextResponse.json(shape(data))
}
