import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { getOrCreateAccountForUser } from "@/lib/sms/account-service"
import { purchaseUnitsByQuantity, quoteCredits } from "@/lib/sms/bundle-service"
import { initializePayment, chargeMobileMoney, detectMomoProvider } from "@/lib/paystack"
import { isWalletDirectChargeEnabled, isWalletOtpRequired, isPhoneOtpVerified } from "@/lib/storefront-otp"
import { applyRateLimit } from "@/lib/rate-limiter"
import { logSecurityEvent } from "@/lib/security-log"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

// POST /api/sms/units/purchase — buy an arbitrary number of credits at the admin
// per-credit fee. Body: { credits: number, paidFrom: "wallet" | "paystack" }.
// The cost is ALWAYS computed server-side from sms_price_per_credit.
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7))
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  let body: { credits?: unknown; paidFrom?: unknown; momoDirect?: unknown; paymentPhone?: unknown }
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) }

  const credits = Number(body.credits)
  const paidFrom = body.paidFrom === "paystack" ? "paystack" : "wallet"
  if (!Number.isInteger(credits) || credits <= 0) {
    return NextResponse.json({ error: "credits must be a positive integer" }, { status: 400 })
  }

  const account = await getOrCreateAccountForUser(user.id)
  if (!account) return NextResponse.json({ error: "No SMS account" }, { status: 403 })
  if (account.owner_type !== "platform" && account.status !== "active") {
    return NextResponse.json({ error: "NOT_ACTIVATED" }, { status: 403 })
  }

  if (paidFrom === "paystack") {
    if (!user.email) return NextResponse.json({ error: "Account email required" }, { status: 400 })
    const { cost } = await quoteCredits(credits)
    if (cost <= 0) return NextResponse.json({ error: "Pricing not configured" }, { status: 400 })
    const reference = `smsqty-${account.id}-${credits}-${Date.now()}`
    // The charge.success webhook (sms_units_qty branch) credits the units off this metadata,
    // for BOTH the hosted redirect and the direct MoMo charge.
    const metadata = { type: "sms_units_qty", sms_account_id: account.id, units: credits }

    // ── Direct MoMo charge (no hosted redirect) when the wallet direct-charge gate is on. ──
    const directOn = await isWalletDirectChargeEnabled()
    if (body.momoDirect === true && directOn) {
      const phone = String(body.paymentPhone || "").trim()
      const provider = detectMomoProvider(phone)
      if (!provider) {
        return NextResponse.json({ error: "Could not detect the mobile money network from that number." }, { status: 400 })
      }
      // OTP gate: when wallet OTP is on, the payment number must be SMS-verified, so a
      // direct charge can never prompt an unverified third-party number.
      const otpRequired = await isWalletOtpRequired()
      if (otpRequired && !(await isPhoneOtpVerified(phone))) {
        return NextResponse.json({ error: "Please verify your payment number to continue.", code: "OTP_REQUIRED" }, { status: 403 })
      }
      // Throttle MoMo prompt-spam. Per-IP (bounds account-rotation behind one IP) + per-user
      // always; per-phone when OTP is off (the OTP gate is the per-number guardrail when on).
      // Mirrors /api/payments/initialize.
      const ipCap = await applyRateLimit(request, "sms_momodirect_ip", 6, 60_000)
      if (!ipCap.allowed) {
        logSecurityEvent("sms_momodirect_ip_cap", { channel: "sms_credits", userId: user.id, paymentPhone: phone })
        return NextResponse.json({ error: "Too many payment attempts. Please try again later." }, { status: 429 })
      }
      const userCap = await applyRateLimit(request, "sms_momodirect_user", 5, 30 * 60 * 1000, `su:${user.id}`)
      if (!userCap.allowed) {
        logSecurityEvent("sms_momodirect_user_cap", { channel: "sms_credits", userId: user.id, paymentPhone: phone })
        return NextResponse.json({ error: "Too many payment attempts. Please try again later." }, { status: 429 })
      }
      if (!otpRequired) {
        const phoneCap = await applyRateLimit(request, "momodirect_phone", 3, 60 * 60 * 1000, `mp:${phone.replace(/\D/g, "")}`)
        if (!phoneCap.allowed) {
          logSecurityEvent("momodirect_phone_cap", { channel: "sms_credits", userId: user.id, paymentPhone: phone })
          return NextResponse.json({ error: "Too many payment attempts for this number. Please try again later." }, { status: 429 })
        }
      }
      const charge = await chargeMobileMoney({
        email: user.email, amount: cost, phone, provider, reference, metadata,
        channel: "sms_credits", purpose: "SMS Credits",
      })
      return NextResponse.json({ success: true, momoDirect: true, reference, status: charge.status, cost })
    }

    // Hosted redirect. When direct charge IS the legit path, strip mobile_money so a
    // hosted page can't prompt a victim number (mirrors /api/payments/initialize).
    const init = await initializePayment({
      email: user.email, amount: cost, reference, purpose: "SMS Credits", metadata,
      channels: directOn ? ["card", "bank_transfer"] : undefined,
    })
    return NextResponse.json({ authorizationUrl: init.authorizationUrl, reference })
  }

  const result = await purchaseUnitsByQuantity(user.id, account.id, credits)
  if (!result.ok) {
    const status = result.error === "NOT_ACTIVATED" ? 403 : result.error === "Insufficient wallet balance" ? 402 : 400
    return NextResponse.json({ error: result.error }, { status })
  }
  return NextResponse.json({
    success: true,
    pending: result.pending ?? false,
    unitsCredited: result.unitsCredited ?? 0,
    cost: result.cost,
  })
}
