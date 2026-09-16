// app/api/v1/sms/send/route.ts
import { NextRequest, NextResponse } from "next/server"
import { authenticateApiKey, logApiRequest } from "@/lib/api-auth"
import { applyRateLimit } from "@/lib/rate-limiter"
import { getOrCreateAccountForUser } from "@/lib/sms/account-service"
import { enqueueSendBatched, SMS_MAX_TOTAL } from "@/lib/sms/send-service"
import { getShopTokens } from "@/lib/sms/shop-context-service"

/**
 * POST /api/v1/sms/send
 * Body: { message: string, recipients: string[], sender_id?: string }
 */
export async function POST(request: NextRequest) {
  const start = Date.now()

  const user = await authenticateApiKey(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Invalid or missing API key" }, { status: 401 })
  }

  const rateLimitCount = user.rate_limit_per_min || 60
  const postLimit = Math.max(5, Math.floor(rateLimitCount / 3))
  const rateLimit = await applyRateLimit(request, "v1_sms_send_post", postLimit, 60 * 1000, user.id)
  if (!rateLimit.allowed) {
    return NextResponse.json({ success: false, error: `Rate limit exceeded. Your current limit is ${postLimit} requests/minute.` }, { status: 429 })
  }

  const account = await getOrCreateAccountForUser(user.id)
  if (!account) {
    return NextResponse.json({ success: false, error: "No SMS account for this API key's owner (requires a shop, sub-agent, or admin account)" }, { status: 403 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const { message, recipients, sender_id } = body
  if (typeof message !== "string" || message.length < 3 || message.length > 1000) {
    return NextResponse.json({ success: false, error: "message must be a string between 3 and 1000 characters" }, { status: 400 })
  }
  if (!Array.isArray(recipients) || recipients.length === 0 || !recipients.every((r) => typeof r === "string")) {
    return NextResponse.json({ success: false, error: "recipients must be a non-empty string array" }, { status: 400 })
  }
  if (recipients.length > SMS_MAX_TOTAL) {
    return NextResponse.json({ success: false, error: `Maximum ${SMS_MAX_TOTAL} recipients per send` }, { status: 400 })
  }
  if (sender_id !== undefined && typeof sender_id !== "string") {
    return NextResponse.json({ success: false, error: "sender_id must be a string" }, { status: 400 })
  }

  const tokens = await getShopTokens(account)
  const uniqueRecipients = Array.from(new Set(recipients as string[]))

  let result: Awaited<ReturnType<typeof enqueueSendBatched>>
  try {
    result = await enqueueSendBatched(user.id, account.id, message, uniqueRecipients, tokens, sender_id)
  } catch (e) {
    console.error("[V1-SMS-SEND] batched send threw:", e)
    return NextResponse.json({ success: false, error: "SEND_ERROR" }, { status: 500 })
  }

  const durationMs = Date.now() - start

  if (!result.ok) {
    const status =
      result.error === "INSUFFICIENT_CREDITS" ? 402 :
      result.error === "NOT_ACTIVATED" || result.error === "SUSPENDED" ? 403 :
      400

    logApiRequest({
      userId: user.id, apiKeyId: user.api_key_id, method: "POST", endpoint: "/api/v1/sms/send",
      statusCode: status, request, durationMs,
      requestPayload: { recipients_count: uniqueRecipients.length },
      responsePayload: { error: result.error },
    }).catch(() => {})

    return NextResponse.json({ success: false, error: result.error }, { status })
  }

  logApiRequest({
    userId: user.id, apiKeyId: user.api_key_id, method: "POST", endpoint: "/api/v1/sms/send",
    statusCode: 200, request, durationMs,
    requestPayload: { recipients_count: uniqueRecipients.length },
    responsePayload: { total: result.totalQueued, batches: result.batches },
  }).catch(() => {})

  return NextResponse.json({
    success: true,
    total: result.totalQueued,
    batches: result.batches,
    segments: result.segments,
    credits_reserved: result.creditsReserved,
    partial: result.partial,
  })
}
