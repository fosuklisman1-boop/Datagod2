import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * GET /api/admin/api-keys
 * Admin: List all API keys across all users
 */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const { searchParams } = new URL(request.url)
  const userId = searchParams.get("userId")

  console.log("[ADMIN API KEYS] Fetching keys...", userId ? `for user ${userId}` : "all")

  let query = supabase
    .from("user_api_keys")
    .select("*")
    .order("created_at", { ascending: false })

  if (userId) {
    query = query.eq("user_id", userId)
  }

  const { data: keys, error } = await query

  if (error) {
    console.error("[ADMIN API KEYS] Fetch error:", error)
    return NextResponse.json({ error: error.message || "Failed to fetch API keys" }, { status: 500 })
  }

  if (!keys || keys.length === 0) {
    console.log("[ADMIN API KEYS] No keys found in database.")
    return NextResponse.json({ keys: [] })
  }

  console.log(`[ADMIN API KEYS] Found ${keys.length} keys. Enriching with user data...`)

  const userIds = Array.from(new Set(keys.map(k => k.user_id).filter(Boolean)))

  if (userIds.length === 0) {
    return NextResponse.json({ keys: keys.map(k => ({ ...k, user: null })) })
  }

  const { data: users, error: userError } = await supabase
    .from("users")
    .select("id, first_name, last_name, email, role")
    .in("id", userIds)

  if (userError) {
    console.warn("[ADMIN API KEYS] Could not fetch user details:", userError)
  }

  const userMap = (users || []).reduce((acc: any, u: any) => {
    acc[u.id] = u
    return acc
  }, {})

  const enrichedKeys = keys.map((k: any) => ({
    ...k,
    rate_limit_per_min: k.rate_limit_per_min ?? 60,
    user: userMap[k.user_id] || { email: "Unknown", first_name: "Deleted", last_name: "User" }
  }))

  return NextResponse.json({ keys: enrichedKeys })
}

/**
 * PATCH /api/admin/api-keys?id=<keyId>
 * Admin: Enable or disable a specific API key
 */
export async function PATCH(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const { searchParams } = new URL(request.url)
  const keyId = searchParams.get("id")

  if (!keyId) {
    return NextResponse.json({ error: "Key ID is required" }, { status: 400 })
  }

  const body = await request.json()
  const { is_active, rate_limit_per_min } = body

  const updateData: any = { updated_at: new Date().toISOString() }
  if (typeof is_active === "boolean") updateData.is_active = is_active
  if (rate_limit_per_min !== undefined) {
    const rateLimit = Number(rate_limit_per_min)
    if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 10000) {
      return NextResponse.json({ error: "rate_limit_per_min must be an integer between 1 and 10000" }, { status: 400 })
    }
    updateData.rate_limit_per_min = rateLimit
  }

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
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

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
