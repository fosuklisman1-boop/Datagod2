import { NextRequest, NextResponse } from "next/server"
import { authenticateApiKey, logApiRequest } from "@/lib/api-auth"
import { applyRateLimit } from "@/lib/rate-limiter"
import { checkPhoneVerified } from "@/lib/phone-verify-guard"
import { classifyServiceError } from "@/lib/api-v1-errors"
import { getBillsRuntime } from "@/lib/bills/runtime"
import { payBill } from "@/lib/bills/service"
import { placeSandboxOrder, getSandboxOrder } from "@/lib/sandbox"
import { NOT_AVAILABLE_BODY, readApiSurface } from "@/lib/api-v1/surface"
import {
  parseAmount, parseExpectedPay, parseSandboxToken, sandboxBillReference, sandboxPriceChanged, orderBody, payErrorBody,
} from "@/lib/api-v1/bills"

// A request must always die well before the 5-minute stuck-claim threshold.
export const maxDuration = 60

/**
 * POST /api/v1/bills
 * Body: { verify_token: string, amount: number, expected_pay?: number }
 * Re-sending a verify_token that already paid returns that order (201, same reference), never a second payment.
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

  const respond = (statusCode: number, resBody: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const order = resBody.order as { reference?: unknown; status?: unknown } | undefined
    logApiRequest({
      userId: user.id, apiKeyId: user.api_key_id, method: "POST", endpoint: "/api/v1/bills",
      statusCode, request, durationMs: Date.now() - start,
      requestPayload: { amount },
      responsePayload: statusCode < 400 && order
        ? { reference: order.reference, status: order.status, ...extra }
        : { error: resBody.error, ...extra },
    }).catch(() => {})
    return NextResponse.json(resBody, { status: statusCode })
  }

  try {
    if (user.environment === "test") {
      const sb = { sandbox: true }
      const t = parseSandboxToken(user.id, token)
      if (!t) return respond(400, { success: false, error: "Please verify the account again" }, sb)
      if (!(amount > 0)) return respond(400, { success: false, error: "Invalid amount" }, sb)

      // One order per sandbox verify_token, like live: a re-send returns the order it already paid.
      const reference = sandboxBillReference(token)
      const replay = async () => {
        const prior = await getSandboxOrder(user.id, reference)
        return prior && prior.action === "utility_bill"
          ? respond(201, { success: true, order: { ...(prior.response as Record<string, unknown>), status: prior.status, sandbox: true } }, sb)
          : null
      }
      const prior = await replay()
      if (prior) return prior

      const price = Math.round(amount * 100) / 100
      const changed = sandboxPriceChanged(price, expectedPay)
      if (changed) return respond(409, changed, sb)

      const placed = await placeSandboxOrder({
        userId: user.id, apiKeyId: user.api_key_id, action: "utility_bill", reference,
        request: { biller: t.biller, account: t.account, amount: price },
        price,
        orderFields: {
          biller: t.biller, account: t.account, customer_name: "Sandbox Customer",
          payment_status: "paid", face_amount: price, paid_amount: price, cashback: 0,
        },
      })
      if (!placed.success) {
        if (placed.status === 409) {
          const raced = await replay()
          if (raced) return raced
        }
        return respond(placed.status, { success: false, error: placed.error }, sb)
      }
      return respond(201, { success: true, order: { ...placed.order, sandbox: true }, new_balance: placed.newBalance }, sb)
    }

    const { deps, db } = getBillsRuntime()
    const surface = await readApiSurface(() => deps.getCashbackConfig())
    if (!surface.open) return respond(403, NOT_AVAILABLE_BODY)

    const guard = await checkPhoneVerified(db, user.id)
    if (!guard.allowed) return respond(403, { success: false, error: guard.error })

    const result = await payBill(deps, user.id, token, amount, expectedPay, { channel: "api" })
    if (!result.ok) return respond(result.status, payErrorBody(result))
    return respond(201, { success: true, order: orderBody(result.order) })
  } catch (e) {
    // The engines return result objects; anything thrown here is unexpected and never leaks its message.
    const { status, publicMessage } = classifyServiceError(e, {}, "Failed to pay bill")
    console.error("[V1-BILLS] pay error:", e instanceof Error ? e.message : "error")
    return respond(status, { success: false, error: publicMessage })
  }
}
