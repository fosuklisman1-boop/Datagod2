import { NextRequest, NextResponse } from "next/server"
import { authenticateApiKey, logApiRequest } from "@/lib/api-auth"
import { applyRateLimit } from "@/lib/rate-limiter"
import { resetSandboxBalance, SANDBOX_STARTING_BALANCE } from "@/lib/sandbox"

/**
 * POST /api/v1/sandbox/reset-balance
 * Test-key only. Refills the caller's sandbox test balance back to its
 * starting credit -- for when a test suite has drained it. Has no real
 * effect on a live key.
 */
export async function POST(request: NextRequest) {
  const start = Date.now()

  const user = await authenticateApiKey(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Invalid or missing API key" }, { status: 401 })
  }

  if (user.environment !== "test") {
    return NextResponse.json(
      { success: false, error: "reset-balance only works with a test key" },
      { status: 400 }
    )
  }

  const rateLimit = await applyRateLimit(request, "v1_sandbox_reset", 10, 60 * 1000, user.id)
  if (!rateLimit.allowed) {
    return NextResponse.json({ success: false, error: "Rate limit exceeded." }, { status: 429 })
  }

  const balance = await resetSandboxBalance(user.id)

  logApiRequest({
    userId: user.id,
    apiKeyId: user.api_key_id,
    method: "POST",
    endpoint: "/api/v1/sandbox/reset-balance",
    statusCode: 200,
    request,
    durationMs: Date.now() - start,
    responsePayload: { balance },
  }).catch(() => {})

  return NextResponse.json({
    success: true,
    balance,
    starting_balance: SANDBOX_STARTING_BALANCE,
    currency: "GHS",
  })
}
