import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { RATE_LIMITS, isHeavyAdminOperation } from "@/lib/rate-limit-config"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

/**
 * Verify admin access for API routes
 * Checks both user_metadata.role and users table role
 * Also applies rate limiting: 100/min for general, 20/min for heavy operations
 * 
 * @param request - NextRequest object
 * @returns Object with isAdmin, userId, and optional error response
 */
export async function verifyAdminAccess(request: NextRequest): Promise<{
  isAdmin: boolean
  userId?: string
  userEmail?: string
  errorResponse?: NextResponse
}> {
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  // Check authorization header
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return {
      isAdmin: false,
      errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    }
  }

  const token = authHeader.slice(7)
  const { data: user, error: userError } = await supabase.auth.getUser(token)

  if (userError || !user?.user?.id) {
    return {
      isAdmin: false,
      errorResponse: NextResponse.json({ error: "Invalid token" }, { status: 401 }),
    }
  }

  // Check if user is admin - first check user_metadata, then users table
  // This matches the frontend useIsAdmin hook behavior
  const isAdminFromMetadata = user.user?.user_metadata?.role === "admin"

  let isAdmin = isAdminFromMetadata

  if (!isAdmin) {
    // Fall back to users table check
    const { data: userData, error: userError2 } = await supabase
      .from("users")
      .select("role")
      .eq("id", user.user.id)
      .single()

    isAdmin = !userError2 && userData?.role === "admin"
  }

  if (!isAdmin) {
    return {
      isAdmin: false,
      userId: user.user.id,
      userEmail: user.user.email,
      errorResponse: NextResponse.json({ error: "Admin access required" }, { status: 403 }),
    }
  }

  // Apply rate limiting for admin endpoints (AFTER auth/authz checks)
  // Determine if this is a heavy operation
  const path = new URL(request.url).pathname
  const isHeavy = isHeavyAdminOperation(path)

  const limitConfig = isHeavy ? RATE_LIMITS.ADMIN_HEAVY : RATE_LIMITS.ADMIN_GENERAL
  const rateLimit = await applyRateLimit(
    request,
    `admin-${isHeavy ? 'heavy' : 'general'}`,
    limitConfig.maxRequests,
    limitConfig.windowMs,
    user.user.id // Use user ID for authenticated rate limiting
  )

  if (!rateLimit.allowed) {
    return {
      isAdmin: true,
      userId: user.user.id,
      userEmail: user.user.email,
      errorResponse: NextResponse.json(
        { error: limitConfig.message },
        {
          status: 429,
          headers: {
            'X-RateLimit-Limit': limitConfig.maxRequests.toString(),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': new Date(rateLimit.resetAt).toISOString(),
          }
        }
      ),
    }
  }

  return {
    isAdmin: true,
    userId: user.user.id,
    userEmail: user.user.email,
  }
}
