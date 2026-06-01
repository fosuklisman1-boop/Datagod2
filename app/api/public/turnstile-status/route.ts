import { NextResponse } from "next/server"
import { isTurnstileEnabled } from "@/lib/turnstile"
import { isStorefrontOtpRequired } from "@/lib/storefront-otp"

/**
 * GET /api/public/turnstile-status
 * Public checkout-requirements endpoint. Returns:
 *   - enabled:      whether to render the Turnstile widget
 *   - otp_required: whether the storefront checkout OTP gate is on
 * No auth required — the answer is the same for every visitor.
 *
 * Cached at the edge for 30 seconds: an admin toggle takes effect within
 * ~30s. New page loads after a toggle pick up the new state immediately.
 */
export async function GET() {
  const [enabled, otpRequired] = await Promise.all([
    isTurnstileEnabled(),
    isStorefrontOtpRequired(),
  ])
  return NextResponse.json(
    { enabled, otp_required: otpRequired },
    {
      headers: {
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
      },
    }
  )
}
