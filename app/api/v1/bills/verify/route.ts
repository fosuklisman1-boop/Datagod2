import { NextRequest, NextResponse } from "next/server"
import { authenticateApiKey, logApiRequest } from "@/lib/api-auth"
import { applyRateLimit } from "@/lib/rate-limiter"
import { checkPhoneVerified } from "@/lib/phone-verify-guard"
import { classifyServiceError } from "@/lib/api-v1-errors"
import { getBillsRuntime } from "@/lib/bills/runtime"
import { verifyBill } from "@/lib/bills/service"
import { NOT_AVAILABLE_BODY, readApiSurface } from "@/lib/api-v1/surface"
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

  // A POST that calls Hubtel: the POST limit, like the other v1 POST endpoints.
  const limit = user.rate_limit_per_min || 60
  const postLimit = Math.max(5, Math.floor(limit / 3))
  const rl = await applyRateLimit(request, "v1_bills_verify", postLimit, 60 * 1000, user.id)
  if (!rl.allowed) {
    return NextResponse.json({ success: false, error: `Rate limit exceeded. Your current limit is ${postLimit} requests/minute.` }, { status: 429 })
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
  const respond = (statusCode: number, resBody: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    logApiRequest({
      userId: user.id, apiKeyId: user.api_key_id, method: "POST", endpoint: "/api/v1/bills/verify",
      statusCode, request, durationMs: Date.now() - start,
      requestPayload: { biller },
      // Never log the verify_token.
      responsePayload: statusCode < 400 ? { biller, ...extra } : { error: resBody.error, ...extra },
    }).catch(() => {})
    return NextResponse.json(resBody, { status: statusCode })
  }

  try {
    if (user.environment === "test") {
      const r = sandboxVerify(user.id, biller, inputs)
      if (!r.ok) return respond(r.status, { success: false, error: r.error }, { sandbox: true })
      return respond(200, { ...r.body, sandbox: true }, { sandbox: true })
    }

    const { deps, db } = getBillsRuntime()
    const surface = await readApiSurface(() => deps.getCashbackConfig())
    if (!surface.open) return respond(403, NOT_AVAILABLE_BODY)

    const guard = await checkPhoneVerified(db, user.id)
    if (!guard.allowed) return respond(403, { success: false, error: guard.error })

    const result = await verifyBill(deps, user.id, biller, inputs)
    if (!result.ok) return respond(result.status, { success: false, error: result.error })
    return respond(200, verifyResponse(result))
  } catch (e) {
    const { status, publicMessage } = classifyServiceError(e, {}, "Failed to verify account")
    console.error("[V1-BILLS] verify error:", e instanceof Error ? e.message : "error")
    return respond(status, { success: false, error: publicMessage })
  }
}
