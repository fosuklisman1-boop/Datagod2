import { NextRequest, NextResponse } from "next/server"
import { Redis } from "@upstash/redis"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

/**
 * POST /api/admin/rate-limits/reset
 * Clears the rate limit for a specific endpoint + identifier combination.
 * Body: { endpoint: string, identifier: string }
 */
export async function POST(request: NextRequest) {
  const { isAdmin, userId: adminId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return NextResponse.json({ error: "Upstash not configured" }, { status: 503 })
  }

  const body = await request.json()
  const { endpoint, identifier } = body

  if (!endpoint || typeof endpoint !== "string" || endpoint.length > 200) {
    return NextResponse.json({ error: "endpoint is required (max 200 chars)" }, { status: 400 })
  }
  if (!identifier || typeof identifier !== "string" || identifier.length > 200) {
    return NextResponse.json({ error: "identifier is required (max 200 chars)" }, { status: 400 })
  }

  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  })

  // Upstash sliding window stores keys under prefix "rl:{key}"
  const redisKey = `rl:${endpoint}:${identifier}`

  try {
    await redis.del(redisKey)
  } catch (err) {
    console.error("[ADMIN RATE-LIMITS RESET] Redis delete error:", err)
    return NextResponse.json({ error: "Failed to reset rate limit in Redis" }, { status: 500 })
  }

  // Also clear the block log for this endpoint+identifier so the UI reflects the reset
  await supabase
    .from("rate_limit_blocks")
    .delete()
    .eq("endpoint", endpoint)
    .eq("identifier", identifier)

  console.log(`[ADMIN RATE-LIMITS RESET] Admin ${adminId} reset limit: ${redisKey}`)

  return NextResponse.json({
    success: true,
    message: `Rate limit cleared for ${identifier} on ${endpoint}`,
    key: redisKey,
  })
}
