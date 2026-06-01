import { NextResponse } from "next/server"
import { isTurnstileEnabled } from "@/lib/turnstile"
import { isStorefrontOtpRequired, isWalletOtpRequired } from "@/lib/storefront-otp"

/**
 * GET /api/public/turnstile-status
 * Public checkout-requirements endpoint. Returns:
 *   - enabled:      whether to render the Turnstile widget
 *   - otp_required: whether the storefront checkout OTP gate is on
 *   - wallet_lock:  whether the wallet/upgrade protection gate is on (dashboard
 *                   top-up & upgrade pages switch to the OTP-verified direct
 *                   charge when this is true)
 * No auth required — the answer is the same for every visitor.
 *
 * Cached at the edge for 30 seconds: an admin toggle takes effect within
 * ~30s. New page loads after a toggle pick up the new state immediately.
 */
export async function GET() {
  const [enabled, otpRequired, walletLock] = await Promise.all([
    isTurnstileEnabled(),
    isStorefrontOtpRequired(),
    isWalletOtpRequired(),
  ])
  return NextResponse.json(
    { enabled, otp_required: otpRequired, wallet_lock: walletLock },
    {
      headers: {
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
      },
    }
  )
}
