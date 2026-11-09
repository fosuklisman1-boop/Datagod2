// app/api/sms/activate/route.ts
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { getOrCreateAccountForUser } from "@/lib/sms/account-service"
import { activateViaWallet, initActivationPaystack, initActivationDirectCharge } from "@/lib/sms/activation-service"
import { isSmsDirectChargeEnabled, isWalletOtpRequired } from "@/lib/storefront-otp"
import { applyRateLimit } from "@/lib/rate-limiter"
import { logSecurityEvent } from "@/lib/security-log"
import { isSmsEnabled, SMS_DISABLED_MESSAGE } from "@/lib/sms/kill-switch"
import { planSmsDirect } from "@/lib/sms/gateway-start"
import { resolveTrustedBaseUrl } from "@/lib/custom-domain-lookup"

// A Hubtel start awaits the relay.
export const maxDuration = 60

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7))
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const account = await getOrCreateAccountForUser(user.id)
  if (!account) return NextResponse.json({ error: "No SMS account" }, { status: 403 })

  const body = await request.json()
  const paidFrom: string = body?.paidFrom ?? "wallet"

  if (paidFrom === "wallet") {
    const result = await activateViaWallet(user.id, account.id)
    if (!result.ok) {
      if (result.error === "SMS_DISABLED") return NextResponse.json({ error: SMS_DISABLED_MESSAGE, code: "SMS_DISABLED" }, { status: 503 })
      const status = result.error === "INSUFFICIENT_BALANCE" ? 402 : 400
      return NextResponse.json({ error: result.error }, { status })
    }
    return NextResponse.json({ success: true })
  }

  if (paidFrom === "paystack") {
    if (!(await isSmsEnabled())) return NextResponse.json({ error: SMS_DISABLED_MESSAGE, code: "SMS_DISABLED" }, { status: 503 })
    if (!user.email) return NextResponse.json({ error: "Account email required for Paystack" }, { status: 400 })

    const directOn = await isSmsDirectChargeEnabled()

    // Direct MoMo charge (on-page prompt) when the wallet direct-charge gate is on.
    if (body?.momoDirect === true && directOn) {
      const otpRequired = await isWalletOtpRequired()
      const plan = await planSmsDirect(supabaseAdmin, { rawPhone: body?.paymentPhone, userId: user.id, otpRequired })
      if (!plan.ok) return NextResponse.json(plan.body, { status: plan.status })
      const { phone, provider } = plan
      // Throttle MoMo prompt-spam. Per-IP (bounds account-rotation behind one IP) + per-user
      // always; per-phone when OTP is off (the OTP gate is the per-number guardrail when on),
      // and always on Hubtel. Mirrors /api/payments/initialize.
      const ipCap = await applyRateLimit(request, "sms_momodirect_ip", 6, 60_000)
      if (!ipCap.allowed) {
        logSecurityEvent("sms_momodirect_ip_cap", { channel: "sms_activation_momo", userId: user.id, paymentPhone: phone })
        return NextResponse.json({ error: "Too many payment attempts. Please try again later." }, { status: 429 })
      }
      const userCap = await applyRateLimit(request, "sms_momodirect_user", 5, 30 * 60 * 1000, `su:${user.id}`)
      if (!userCap.allowed) {
        logSecurityEvent("sms_momodirect_user_cap", { channel: "sms_activation_momo", userId: user.id, paymentPhone: phone })
        return NextResponse.json({ error: "Too many payment attempts. Please try again later." }, { status: 429 })
      }
      if (!otpRequired || plan.gateway === "hubtel") {
        const phoneCap = await applyRateLimit(request, "momodirect_phone", 3, 60 * 60 * 1000, `mp:${phone.replace(/\D/g, "")}`)
        if (!phoneCap.allowed) {
          logSecurityEvent("momodirect_phone_cap", { channel: "sms_activation_momo", userId: user.id, paymentPhone: phone })
          return NextResponse.json({ error: "Too many payment attempts for this number. Please try again later." }, { status: 429 })
        }
      }
      const result = await initActivationDirectCharge(user.id, account.id, user.email, phone, provider, { verifiedPayer: plan.gateway === "hubtel" })
      if (!result.ok) {
        if (result.error === "SMS_DISABLED") return NextResponse.json({ error: SMS_DISABLED_MESSAGE, code: "SMS_DISABLED" }, { status: 503 })
        return NextResponse.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, { status: result.httpStatus ?? 400 })
      }
      return NextResponse.json({ success: true, momoDirect: true, reference: result.reference, status: result.status })
    }

    // Hosted redirect. When direct charge IS the legit path, strip mobile_money so the
    // hosted page can't prompt a victim number (mirrors the Buy-Credits route).
    const result = await initActivationPaystack(user.id, account.id, user.email, directOn ? ["card", "bank_transfer"] : undefined, {
      redirectUrl: async () => `${await resolveTrustedBaseUrl(request.headers.get("host"))}/dashboard/sms`,
    })
    if (!result.ok) {
      if (result.error === "SMS_DISABLED") return NextResponse.json({ error: SMS_DISABLED_MESSAGE, code: "SMS_DISABLED" }, { status: 503 })
      return NextResponse.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, { status: result.httpStatus ?? 400 })
    }
    return NextResponse.json({ authorizationUrl: result.authorizationUrl, reference: result.reference })
  }

  return NextResponse.json({ error: "paidFrom must be 'wallet' or 'paystack'" }, { status: 400 })
}
