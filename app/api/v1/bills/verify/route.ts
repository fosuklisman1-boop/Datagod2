import { NextRequest, NextResponse } from "next/server"
import { authenticateApiKey, logApiRequest } from "@/lib/api-auth"
import { applyRateLimit } from "@/lib/rate-limiter"
import { checkPhoneVerified } from "@/lib/phone-verify-guard"
import { getBillsRuntime } from "@/lib/bills/runtime"
import { verifyBill } from "@/lib/bills/service"
import { parseVerifyBody, sandboxVerify, verifyResponse } from "@/lib/api-v1/bills"

/**
 * POST /api/v1/bills/verify
 * Body: { biller, account?, phone?, email?, broadband_account?, meter_type?, add_meter?, consent? }
 */
export async function POST(request: NextRequest) {
  const start = Date.now()
  const user = await authenticateApiKey(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Invalid or missing API key" }, { status: 401 })
  }

  const limit = user.rate_limit_per_min || 60
  const rl = await applyRateLimit(request, "v1_bills_verify", limit, 60 * 1000, user.id)
  if (!rl.allowed) {
    return NextResponse.json({ success: false, error: "Rate limit exceeded." }, { status: 429 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const { biller, inputs } = parseVerifyBody(body)
  const log = (statusCode: number, responsePayload: Record<string, unknown>) =>
    logApiRequest({
      userId: user.id, apiKeyId: user.api_key_id, method: "POST", endpoint: "/api/v1/bills/verify",
      statusCode, request, durationMs: Date.now() - start,
      requestPayload: { biller }, responsePayload,
    }).catch(() => {})

  try {
    if (user.environment === "test") {
      const r = sandboxVerify(user.id, biller, inputs)
      if (!r.ok) {
        log(r.status, { error: r.error })
        return NextResponse.json({ success: false, error: r.error }, { status: r.status })
      }
      log(200, { sandbox: true })
      return NextResponse.json({ ...r.body, sandbox: true })
    }

    const { deps, db } = getBillsRuntime()
    const guard = await checkPhoneVerified(db, user.id)
    if (!guard.allowed) {
      return NextResponse.json({ success: false, error: guard.error }, { status: 403 })
    }

    const result = await verifyBill(deps, user.id, biller, inputs)
    if (!result.ok) {
      log(result.status, { error: result.error })
      return NextResponse.json({ success: false, error: result.error }, { status: result.status })
    }
    log(200, { biller })
    return NextResponse.json(verifyResponse(result))
  } catch (e) {
    console.error("[V1-BILLS] verify error:", e instanceof Error ? e.message : "error")
    log(500, { error: "Failed to verify account" })
    return NextResponse.json({ success: false, error: "Failed to verify account" }, { status: 500 })
  }
}
