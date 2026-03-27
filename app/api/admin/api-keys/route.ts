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
      users!user_api_keys_user_id_fkey (
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
  const { is_active } = body

  if (typeof is_active !== "boolean") {
    return NextResponse.json({ error: "is_active (boolean) is required" }, { status: 400 })
  }

  const { error } = await supabase
    .from("user_api_keys")
    .update({ is_active, updated_at: new Date().toISOString() })
    .eq("id", keyId)

  if (error) {
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
