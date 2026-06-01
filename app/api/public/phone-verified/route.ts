import { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { isPhoneVerified } from "@/lib/storefront-otp"

/**
 * POST /api/public/phone-verified  { phone }  →  { verified: boolean }
 *
 * Lets the storefront checkout skip the OTP step for a phone that has already
 * completed verification (one-time). Purely a UX optimization — the order
 * endpoints still enforce isPhoneVerified server-side, so a gamed client
 * response gains nothing. Rate-limited to deter phone enumeration.
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

    const verified = await isPhoneVerified(phone)
    return NextResponse.json({ verified })
  } catch {
    return NextResponse.json({ verified: false })
  }
}
