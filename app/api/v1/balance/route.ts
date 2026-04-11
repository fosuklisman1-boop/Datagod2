import { NextRequest, NextResponse } from "next/server"
import { authenticateApiKey, logApiRequest } from "@/lib/api-auth"
import { createClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/rate-limiter"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * GET /api/v1/balance
 * Returns the authenticated user's wallet balance
 */
export async function GET(request: NextRequest) {
  const start = Date.now()

  // Authenticate first — rate limit keyed to user ID not IP
  const user = await authenticateApiKey(request)
  if (!user) {
    return NextResponse.json(
      { success: false, error: "Invalid or missing API key" },
      { status: 401 }
    )
  }

  const rateLimitCount = user.rate_limit_per_min || 60
  const rateLimit = await applyRateLimit(request, "v1_balance", rateLimitCount, 60 * 1000, user.id)
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { success: false, error: `Rate limit exceeded. Max ${rateLimitCount} requests/minute.` },
      { status: 429 }
    )
  }

  // Fetch wallet
  const { data: wallet, error } = await supabase
    .from("wallets")
    .select("balance, total_credited, total_spent")
    .eq("user_id", user.id)
    .single()

  const status = error ? 500 : 200
  const duration = Date.now() - start

  const responsePayload = error
    ? { error: "Failed to fetch wallet balance" }
    : {
        balance: wallet ? parseFloat(wallet.balance.toFixed(2)) : null,
        total_credited: wallet ? parseFloat(wallet.total_credited.toFixed(2)) : null,
        total_spent: wallet ? parseFloat(wallet.total_spent.toFixed(2)) : null,
      }

  logApiRequest({
    userId: user.id,
    apiKeyId: user.api_key_id,
    method: "GET",
    endpoint: "/api/v1/balance",
    statusCode: status,
    request,
    durationMs: duration,
    responsePayload,
  }).catch(() => {})

  if (error || !wallet) {
    return NextResponse.json(
      { success: false, error: "Failed to fetch wallet balance" },
      { status: 500 }
    )
  }

  return NextResponse.json({
    success: true,
    balance: parseFloat(wallet.balance.toFixed(2)),
    total_credited: parseFloat(wallet.total_credited.toFixed(2)),
    total_spent: parseFloat(wallet.total_spent.toFixed(2)),
    currency: "GHS",
    user: {
      name: user.first_name,
      role: user.role,
    },
  })
}
