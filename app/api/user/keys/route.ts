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
 * List the authenticated user's API keys -- at most one per environment
 * (test/live), enforced by a DB unique index.
 */
export async function GET(request: NextRequest) {
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
    .select("id, name, key_prefix, is_active, environment, last_used_at, created_at")
    .eq("user_id", sessionUser.id)
    .eq("is_active", true)
    .order("created_at", { ascending: false })

  if (error) {
    return NextResponse.json({ error: "Failed to fetch API keys" }, { status: 500 })
  }

  return NextResponse.json({ keys })
}

/**
 * POST /api/user/keys
 * Generate (or regenerate) the key for one environment. Since a user can
 * have at most one active key per environment, generating a new one
 * deactivates any existing active key for that same environment first --
 * this IS "regenerate", there's no separate regenerate endpoint.
 */
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("Authorization")
  const token = authHeader?.replace("Bearer ", "")
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { data: { user: sessionUser } } = await supabase.auth.getUser(token)
  if (!sessionUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Per-user rate limit (anti-burst on a single account)
  const rateLimit = await applyRateLimit(request, "api_key_generate", 10, 60 * 60 * 1000, sessionUser.id)
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 })
  }
  // Per-IP rate limit (anti multi-account parallelisation)
  const ipRateLimit = await applyRateLimit(request, "api_key_generate_ip", 20, 60 * 60 * 1000)
  if (!ipRateLimit.allowed) {
    return NextResponse.json({ error: "Too many key generations from this network. Please slow down." }, { status: 429 })
  }

  const body = await request.json().catch(() => ({}))
  const environment = body.environment === "test" ? "test" : body.environment === "live" ? "live" : null
  if (!environment) {
    return NextResponse.json({ error: "environment must be 'test' or 'live'" }, { status: 400 })
  }

  // Deactivate any existing active key for this environment -- generating a
  // new one always replaces the old one, since only one can be active.
  await supabase
    .from("user_api_keys")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("user_id", sessionUser.id)
    .eq("environment", environment)
    .eq("is_active", true)

  const { key, prefix, hash } = generateApiKey(environment)
  const name = environment === "test" ? "Test key" : "Live key"

  const { data: newKey, error } = await supabase
    .from("user_api_keys")
    .insert({
      user_id: sessionUser.id,
      name,
      key_hash: hash,
      key_prefix: prefix,
      is_active: true,
      environment,
    })
    .select("id, name, key_prefix, environment, created_at")
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
 * Revoke an API key (without generating a replacement).
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
