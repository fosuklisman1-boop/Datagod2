import { NextResponse } from "next/server"
import { isTurnstileEnabled } from "@/lib/turnstile"
import { resolveSurfaceGateway } from "@/lib/payment-gateway/start"
import { storefrontOtpStep } from "@/lib/payment-gateway/wallet-topup-display"
import {
  isStorefrontOtpRequired,
  isWalletOtpRequired,
  isPhoneGateDisabled,
  isStorefrontDirectChargeEnabled,
  isWalletDirectChargeEnabled,
  isDashboardDirectChargeEnabled,
  isSmsDirectChargeEnabled,
} from "@/lib/storefront-otp"

/**
 * GET /api/public/turnstile-status
 * Public checkout-requirements endpoint. Returns:
 *   - enabled:             whether to render the Turnstile widget
 *   - otp_required:        whether the storefront checkout OTP gate is on
 *   - direct_charge:       whether the storefront uses the on-page direct MoMo
 *                          charge (vs the hosted Paystack redirect)
 *   - wallet_lock:         whether the wallet/upgrade OTP gate is on
 *   - wallet_direct_charge whether wallet top-up uses the on-page direct charge
 *   - dashboard_direct_charge / sms_direct_charge: same, for dealer upgrade / SMS purchases
 * No auth required — the answer is the same for every visitor.
 *
 * Cached at the edge for 30 seconds: an admin toggle takes effect within
 * ~30s. New page loads after a toggle pick up the new state immediately.
 */
export async function GET() {
  const [enabled, otpRequired, directCharge, walletLock, walletDirectCharge, dashboardDirectCharge, smsDirectCharge, phoneGateDisabled, walletGateway, storefrontGateway, dashboardGateway, smsGateway] = await Promise.all([
    isTurnstileEnabled(),
    isStorefrontOtpRequired(),
    isStorefrontDirectChargeEnabled(),
    isWalletOtpRequired(),
    isWalletDirectChargeEnabled(),
    isDashboardDirectChargeEnabled(),
    isSmsDirectChargeEnabled(),
    isPhoneGateDisabled(),
    // Display only: which gateway each checkout should describe. Never throws (a failed read answers paystack).
    resolveSurfaceGateway("wallet_topup", { verifiedPayer: true }).then((r) => r.gateway),
    resolveSurfaceGateway("storefront", { verifiedPayer: true }).then((r) => r.gateway),
    resolveSurfaceGateway("dashboard_direct", { verifiedPayer: true }).then((r) => r.gateway),
    resolveSurfaceGateway("sms", { verifiedPayer: true }).then((r) => r.gateway),
  ])
  return NextResponse.json(
    {
      enabled,
      otp_required: storefrontOtpStep({ otpRequired, gateway: storefrontGateway, direct: directCharge }),
      direct_charge: directCharge,
      wallet_lock: walletLock,
      wallet_direct_charge: walletDirectCharge,
      dashboard_direct_charge: dashboardDirectCharge,
      sms_direct_charge: smsDirectCharge,
      phone_gate_disabled: phoneGateDisabled,
      wallet_gateway: walletGateway,
      storefront_gateway: storefrontGateway,
      dashboard_gateway: dashboardGateway,
      sms_gateway: smsGateway,
    },
    {
      headers: {
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
      },
    }
  )
}
