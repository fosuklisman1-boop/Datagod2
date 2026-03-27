import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { generateApiKey } from "@/lib/api-auth"
import { applyRateLimit } from "@/lib/rate-limiter"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * GET /api/user/keys
 * List all API keys for the authenticated user (via session)
 */
export async function GET(request: NextRequest) {
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  // We need to verify via the session cookie
  const authHeader = request.headers.get("Authorization")
  const token = authHeader?.replace("Bearer ", "")
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { data: { user: sessionUser } } = await supabase.auth.getUser(token)
  if (!sessionUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { data: keys, error } = await supabase
    .from("user_api_keys")
    .select("id, name, key_prefix, is_active, last_used_at, created_at")
    .eq("user_id", sessionUser.id)
    .order("created_at", { ascending: false })

  if (error) {
    return NextResponse.json({ error: "Failed to fetch API keys" }, { status: 500 })
  }

  return NextResponse.json({ keys })
}

/**
 * POST /api/user/keys
 * Generate a new API key. Key is returned only once.
 */
export async function POST(request: NextRequest) {
  const rateLimit = await applyRateLimit(request, "api_key_generate", 5, 60 * 60 * 1000)
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 })
  }

  const authHeader = request.headers.get("Authorization")
  const token = authHeader?.replace("Bearer ", "")
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { data: { user: sessionUser } } = await supabase.auth.getUser(token)
  if (!sessionUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Check user role (only dealers and admins can generate keys)
  const { data: profile } = await supabase
    .from("users")
    .select("role")
    .eq("id", sessionUser.id)
    .single()

  if (!profile || !["dealer", "admin"].includes(profile.role)) {
    return NextResponse.json(
      { error: "Only dealers and admins can generate API keys" },
      { status: 403 }
    )
  }

  // Limit to 5 active keys per user
  const { count } = await supabase
    .from("user_api_keys")
    .select("id", { count: "exact", head: true })
    .eq("user_id", sessionUser.id)
    .eq("is_active", true)

  if ((count || 0) >= 5) {
    return NextResponse.json(
      { error: "Maximum of 5 active API keys reached" },
      { status: 400 }
    )
  }

  const body = await request.json()
  const name = body.name?.trim() || "API Key"

  const { key, prefix, hash } = generateApiKey()

  const { data: newKey, error } = await supabase
    .from("user_api_keys")
    .insert({
      user_id: sessionUser.id,
      name,
      key_hash: hash,
      key_prefix: prefix,
      is_active: true,
    })
    .select("id, name, key_prefix, created_at")
    .single()

  if (error) {
    return NextResponse.json({ error: "Failed to create API key" }, { status: 500 })
  }

  // Return the full key ONLY ONCE
  return NextResponse.json({
    message: "API key created. Save this key securely — it will not be shown again.",
    key,
    ...newKey,
  }, { status: 201 })
}

/**
 * DELETE /api/user/keys?id=<keyId>
 * Revoke an API key
 */
export async function DELETE(request: NextRequest) {
  const authHeader = request.headers.get("Authorization")
  const token = authHeader?.replace("Bearer ", "")
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { data: { user: sessionUser } } = await supabase.auth.getUser(token)
  if (!sessionUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const keyId = searchParams.get("id")
  if (!keyId) {
    return NextResponse.json({ error: "Key ID is required" }, { status: 400 })
  }

  const { error } = await supabase
    .from("user_api_keys")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", keyId)
    .eq("user_id", sessionUser.id) // Ensure user can only revoke their own keys

  if (error) {
    return NextResponse.json({ error: "Failed to revoke API key" }, { status: 500 })
  }

  return NextResponse.json({ message: "API key revoked successfully" })
}
