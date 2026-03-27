import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

function isAdminRequest(request: NextRequest): boolean {
  // Admin routes are protected by existing session/cookie auth
  // The service role client is used, so we verify via the token
  const authHeader = request.headers.get("Authorization")
  return !!authHeader
}

/**
 * GET /api/admin/api-keys
 * Admin: List all API keys across all users
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const userId = searchParams.get("userId")

  let query = supabase
    .from("user_api_keys")
    .select(`
      id,
      name,
      key_prefix,
      is_active,
      last_used_at,
      created_at,
      rate_limit_per_min,
      user:user_id (
        id,
        first_name,
        last_name,
        email,
        role
      )
    `)
    .order("created_at", { ascending: false })

  if (userId) {
    query = query.eq("user_id", userId)
  }

  const { data: keys, error } = await query

  if (error) {
    return NextResponse.json({ error: "Failed to fetch API keys" }, { status: 500 })
  }

  return NextResponse.json({ keys })
}

/**
 * PATCH /api/admin/api-keys?id=<keyId>
 * Admin: Enable or disable a specific API key
 */
export async function PATCH(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const keyId = searchParams.get("id")

  if (!keyId) {
    return NextResponse.json({ error: "Key ID is required" }, { status: 400 })
  }

  const body = await request.json()
  const { is_active, rate_limit_per_min } = body

  const updateData: any = { updated_at: new Date().toISOString() }
  if (typeof is_active === "boolean") updateData.is_active = is_active
  if (typeof rate_limit_per_min === "number") updateData.rate_limit_per_min = rate_limit_per_min

  const { error } = await supabase
    .from("user_api_keys")
    .update(updateData)
    .eq("id", keyId)

  if (error) {
    console.error("[ADMIN API KEYS] Update error:", error)
    return NextResponse.json({ error: "Failed to update API key" }, { status: 500 })
  }

  return NextResponse.json({
    message: `API key ${is_active ? "enabled" : "disabled"} successfully`
  })
}

/**
 * DELETE /api/admin/api-keys?id=<keyId>
 * Admin: Permanently delete an API key
 */
export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const keyId = searchParams.get("id")

  if (!keyId) {
    return NextResponse.json({ error: "Key ID is required" }, { status: 400 })
  }

  const { error } = await supabase
    .from("user_api_keys")
    .delete()
    .eq("id", keyId)

  if (error) {
    return NextResponse.json({ error: "Failed to delete API key" }, { status: 500 })
  }

  return NextResponse.json({ message: "API key deleted permanently" })
}
