import { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { isPhoneOtpVerified } from "@/lib/storefront-otp"

/**
 * POST /api/public/phone-verified  { phone }  →  { verified: boolean }
 *
 * Lets the storefront checkout skip the OTP step for a phone that already has a
 * REAL SMS OTP (used=true) — NOT a grandfathered past-order number, so this
 * matches what the charge gates now require (a returning customer verifies their
 * payment number once, then auto-skips forever after). Purely a UX optimization:
 * the order/charge endpoints re-check server-side, so a gamed client response
 * gains nothing. Rate-limited to deter phone enumeration.
 */
export async function POST(request: NextRequest) {
  try {
    const rl = await applyRateLimit(request, "phone_verified_check", 20, 60_000)
    if (!rl.allowed) {
      return NextResponse.json({ verified: false }, { status: 429 })
    }

    const { phone } = await request.json()
    if (!phone || typeof phone !== "string") {
      return NextResponse.json({ verified: false })
    }

    const verified = await isPhoneOtpVerified(phone)
    return NextResponse.json({ verified })
  } catch {
    return NextResponse.json({ verified: false })
  }
}
