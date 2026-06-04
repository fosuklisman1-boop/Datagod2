import { NextResponse } from "next/server"
import { isTurnstileEnabled } from "@/lib/turnstile"
import {
  isStorefrontOtpRequired,
  isWalletOtpRequired,
  isPhoneGateDisabled,
  isStorefrontDirectChargeEnabled,
  isWalletDirectChargeEnabled,
} from "@/lib/storefront-otp"

/**
 * GET /api/public/turnstile-status
 * Public checkout-requirements endpoint. Returns:
 *   - enabled:             whether to render the Turnstile widget
 *   - otp_required:        whether the storefront checkout OTP gate is on
 *   - direct_charge:       whether the storefront uses the on-page direct MoMo
 *                          charge (vs the hosted Paystack redirect)
 *   - wallet_lock:         whether the wallet/upgrade OTP gate is on
 *   - wallet_direct_charge whether wallet/upgrade uses the on-page direct charge
 * No auth required — the answer is the same for every visitor.
 *
 * Cached at the edge for 30 seconds: an admin toggle takes effect within
 * ~30s. New page loads after a toggle pick up the new state immediately.
 */
export async function GET() {
  const [enabled, otpRequired, directCharge, walletLock, walletDirectCharge, phoneGateDisabled] = await Promise.all([
    isTurnstileEnabled(),
    isStorefrontOtpRequired(),
    isStorefrontDirectChargeEnabled(),
    isWalletOtpRequired(),
    isWalletDirectChargeEnabled(),
    isPhoneGateDisabled(),
  ])
  return NextResponse.json(
    {
      enabled,
      otp_required: otpRequired,
      direct_charge: directCharge,
      wallet_lock: walletLock,
      wallet_direct_charge: walletDirectCharge,
      phone_gate_disabled: phoneGateDisabled,
    },
    {
      headers: {
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
      },
    }
  )
}
