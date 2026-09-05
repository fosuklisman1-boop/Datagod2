import { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { RATE_LIMITS } from "@/lib/rate-limit-config"
import { checkCustomerFacingVerification } from "@/lib/mtn-providers/customer-verification"

const MAX_PHONES = 100

export async function POST(request: NextRequest) {
  const rateLimit = await applyRateLimit(
    request,
    "verify_phone_live",
    RATE_LIMITS.VERIFY_PHONE_LIVE.maxRequests,
    RATE_LIMITS.VERIFY_PHONE_LIVE.windowMs
  )
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: RATE_LIMITS.VERIFY_PHONE_LIVE.message },
      {
        status: 429,
        headers: {
          "X-RateLimit-Limit": RATE_LIMITS.VERIFY_PHONE_LIVE.maxRequests.toString(),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": new Date(rateLimit.resetAt).toISOString(),
        },
      }
    )
  }

  let phones: unknown
  try {
    const body = await request.json()
    phones = body?.phones
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (!Array.isArray(phones) || phones.length === 0 || !phones.every(p => typeof p === "string")) {
    return NextResponse.json({ error: "'phones' must be a non-empty array of strings" }, { status: 400 })
  }
  if (phones.length > MAX_PHONES) {
    return NextResponse.json({ error: `'phones' cannot exceed ${MAX_PHONES} entries` }, { status: 400 })
  }

  try {
    const results = await checkCustomerFacingVerification(phones)
    return NextResponse.json({ results })
  } catch (error) {
    // Fail open — a broken verification check must never block checkout.
    console.error("[VERIFY-PHONE-LIVE] Error, failing open:", error)
    return NextResponse.json({ results: phones.map(phone => ({ phone, verified: true })) })
  }
}
