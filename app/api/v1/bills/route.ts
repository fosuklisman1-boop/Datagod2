import { NextRequest, NextResponse } from "next/server"
import { authenticateApiKey, logApiRequest } from "@/lib/api-auth"
import { applyRateLimit } from "@/lib/rate-limiter"
import { checkPhoneVerified } from "@/lib/phone-verify-guard"
import { getBillsRuntime } from "@/lib/bills/runtime"
import { payBill } from "@/lib/bills/service"
import { placeSandboxOrder } from "@/lib/sandbox"
import {
  parseAmount, parseExpectedPay, parseSandboxToken, sandboxBillReference, orderBody, payErrorBody,
} from "@/lib/api-v1/bills"

// A request must always die well before the 5-minute stuck-claim threshold.
export const maxDuration = 60

/**
 * POST /api/v1/bills
 * Body: { verify_token: string, amount: number, expected_pay?: number }
 */
export async function POST(request: NextRequest) {
  const start = Date.now()
  const user = await authenticateApiKey(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Invalid or missing API key" }, { status: 401 })
  }

  const limit = user.rate_limit_per_min || 60
  const postLimit = Math.max(5, Math.floor(limit / 3))
  const rl = await applyRateLimit(request, "v1_bills_post", postLimit, 60 * 1000, user.id)
  if (!rl.allowed) {
    return NextResponse.json({ success: false, error: `Rate limit exceeded. Your current limit is ${postLimit} requests/minute.` }, { status: 429 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }
  const token = body?.verify_token
  const amount = parseAmount(body?.amount)
  if (typeof token !== "string" || !token || !Number.isFinite(amount)) {
    return NextResponse.json({ success: false, error: "verify_token and a numeric amount are required" }, { status: 400 })
  }
  const expectedPay = parseExpectedPay(body?.expected_pay)

  const log = (statusCode: number, responsePayload: Record<string, unknown>) =>
    logApiRequest({
      userId: user.id, apiKeyId: user.api_key_id, method: "POST", endpoint: "/api/v1/bills",
      statusCode, request, durationMs: Date.now() - start,
      requestPayload: { amount }, responsePayload,
    }).catch(() => {})

  try {
    if (user.environment === "test") {
      const t = parseSandboxToken(user.id, token)
      if (!t) {
        return NextResponse.json({ success: false, error: "Please verify the account again" }, { status: 400 })
      }
      if (!(amount > 0)) {
        return NextResponse.json({ success: false, error: "Invalid amount" }, { status: 400 })
      }
      const price = Math.round(amount * 100) / 100
      const reference = sandboxBillReference()
      // sandbox_orders.action is CHECK-constrained (no migration in this plan), so bills ride the
      // "airtime" action and are told apart by `kind` in the stored response.
      const placed = await placeSandboxOrder({
        userId: user.id, apiKeyId: user.api_key_id, action: "airtime", reference,
        request: { kind: "utility_bill", biller: t.biller, account: t.account, amount: price },
        price,
        orderFields: {
          kind: "utility_bill", biller: t.biller, account: t.account, customer_name: "Sandbox Customer",
          payment_status: "paid", face_amount: price, paid_amount: price, cashback: 0,
        },
      })
      if (!placed.success) {
        log(placed.status, { error: placed.error })
        return NextResponse.json({ success: false, error: placed.error }, { status: placed.status })
      }
      const { kind: _k, ...order } = placed.order as Record<string, unknown>
      log(201, { reference, sandbox: true })
      return NextResponse.json({ success: true, order: { ...order, sandbox: true }, new_balance: placed.newBalance }, { status: 201 })
    }

    const { deps, db } = getBillsRuntime()
    const guard = await checkPhoneVerified(db, user.id)
    if (!guard.allowed) {
      return NextResponse.json({ success: false, error: guard.error }, { status: 403 })
    }

    const result = await payBill(deps, user.id, token, amount, expectedPay, { channel: "api" })
    if (!result.ok) {
      log(result.status, { error: result.error })
      return NextResponse.json(payErrorBody(result), { status: result.status })
    }
    log(201, { reference: result.order.reference_code, status: result.order.status })
    return NextResponse.json({ success: true, order: orderBody(result.order) }, { status: 201 })
  } catch (e) {
    console.error("[V1-BILLS] pay error:", e instanceof Error ? e.message : "error")
    log(500, { error: "Failed to pay bill" })
    return NextResponse.json({ success: false, error: "Failed to pay bill" }, { status: 500 })
  }
}
