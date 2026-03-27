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

  // Rate limit: 60 requests per minute per API key
  const rateLimit = await applyRateLimit(request, "v1_balance", 60, 60 * 1000)
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { success: false, error: "Rate limit exceeded. Max 60 requests/minute." },
      { status: 429 }
    )
  }

  // Authenticate
  const user = await authenticateApiKey(request)
  if (!user) {
    return NextResponse.json(
      { success: false, error: "Invalid or missing API key" },
      { status: 401 }
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

  logApiRequest({
    userId: user.id,
    apiKeyId: user.api_key_id,
    method: "GET",
    endpoint: "/api/v1/balance",
    statusCode: status,
    request,
    durationMs: duration,
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
