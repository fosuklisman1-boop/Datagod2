// In-process SMS verification of the MoMo number a WhatsApp bot buyer types (the "paying number"), for when the
// storefront OTP switch (isStorefrontOtpRequired) is on: botChargeMomo answers NEEDS_VERIFY until the number has a
// real OTP verification (isPhoneOtpVerified). The bot sends a code here and checks the code the buyer types back.
//
// Same table and rules as /api/auth/send-phone-otp + verify-phone-otp (the shared core in lib/phone-otp):
// - send: at most 3 codes per number per hour (DB count, shared with the web flow), plus the route's burst cap
//   (2 / min) applied per number since there is no client IP in-process; 6-digit code, 10-minute expiry.
// - verify: the route's per-number Upstash bucket (verify_phone_otp_phone, otpv:<digits>, 6 / 10 min, the SAME
//   bucket), the bump_otp_attempts DB counter (fail closed; > 6 refused), then used=true on the matching code.
// The number is always stored in local 0XXXXXXXXX form, so caps and lookups see one spelling.
import { createClient } from "@supabase/supabase-js"
import { normalizeGhanaPhone } from "@/lib/phone-format"
import {
  checkPhoneOtp, defaultPhoneOtpCode, hasLivePhoneOtp, issuePhoneOtp, phoneOtpVerifyLimitId, PHONE_OTP_VERIFY_PHONE_LIMIT,
  type PhoneOtpDeps,
} from "@/lib/phone-otp"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import { botCapDeps } from "./runtime"

/** The purpose the storefront checkout's payment-number OTP uses (the route default); isPhoneOtpVerified ignores it. */
export const PAYER_OTP_PURPOSE = "signup"

/** The send route's per-IP burst cap, applied per number here (keyed otps:<0XXXXXXXXX>). */
export const PAYER_OTP_BURST = { name: "phone_otp_burst", max: 2, windowMs: 60_000 } as const

export interface PayerVerifyDeps extends PhoneOtpDeps {
  /** Atomic sliding-window limiter (applyRateLimit's store); true = allowed. Fails open like applyRateLimit. */
  rateLimit(name: string, max: number, windowMs: number, id: string): Promise<boolean>
}

export type SendPayerOtpResult = { ok: true } | { ok: false; code: "RATE_LIMITED" | "SEND_FAILED" }
/**
 * - `{ ok: true }`: verified (the code row is now used=true).
 * - `{ ok: false, retry: true }`: wrong code with a live code still waiting, malformed input, or a transient failure
 *   (nothing verified): the buyer may type the code again.
 * - `{ ok: false, retry: false }`: no live code (expired / already used / never sent), or an attempt cap was hit:
 *   a new code is needed.
 */
export interface VerifyPayerOtpResult { ok: boolean; retry: boolean }

const TAG = "[BOT-PAYER-OTP]"
const errText = (e: unknown) => (e instanceof Error ? e.message : "error")

/** SMS result shape of lib/sms-service sendSMS: only a real, non-skipped success counts as sent. */
function smsSent(r: unknown): boolean {
  const x = r as { success?: unknown; skipped?: unknown } | null
  return !!x && x.success === true && x.skipped !== true
}

export function createPayerVerify(d: PayerVerifyDeps) {
  async function sendPayerOtp(phone: string): Promise<SendPayerOtpResult> {
    const local = normalizeGhanaPhone(phone)
    if (!local) return { ok: false, code: "SEND_FAILED" }
    try {
      const b = PAYER_OTP_BURST
      if (!(await d.rateLimit(b.name, b.max, b.windowMs, `otps:${local}`))) return { ok: false, code: "RATE_LIMITED" }
      const r = await issuePhoneOtp(d, local, PAYER_OTP_PURPOSE)
      if (!r.ok) return { ok: false, code: r.reason === "PHONE_LIMIT" ? "RATE_LIMITED" : "SEND_FAILED" }
      if (!smsSent(r.sms)) {
        console.error(TAG, "code SMS not sent")
        return { ok: false, code: "SEND_FAILED" }
      }
      return { ok: true }
    } catch (e) {
      console.error(TAG, "send failed:", errText(e))
      return { ok: false, code: "SEND_FAILED" }
    }
  }

  async function verifyPayerOtp(phone: string, code: string): Promise<VerifyPayerOtpResult> {
    const local = normalizeGhanaPhone(phone)
    if (!local) return { ok: false, retry: false }
    const c = String(code ?? "").trim()
    if (!/^\d{6}$/.test(c)) return { ok: false, retry: true }
    try {
      const cap = PHONE_OTP_VERIFY_PHONE_LIMIT
      if (!(await d.rateLimit(cap.name, cap.max, cap.windowMs, phoneOtpVerifyLimitId(local)))) return { ok: false, retry: false }
      const r = await checkPhoneOtp(d, local, c, PAYER_OTP_PURPOSE)
      if (r === "verified") return { ok: true, retry: false }
      if (r === "too_many_attempts") return { ok: false, retry: false }
      if (r === "unavailable") return { ok: false, retry: true }
      return { ok: false, retry: await hasLivePhoneOtp(d, local, PAYER_OTP_PURPOSE) }
    } catch (e) {
      console.error(TAG, "verify failed:", errText(e))
      return { ok: false, retry: true }
    }
  }

  return { sendPayerOtp, verifyPayerOtp }
}

let runtime: ReturnType<typeof createPayerVerify> | null = null

/** Service-role wiring: phone_otp_verifications, sendSMS (OTP category), applyRateLimit's store. */
function getPayerVerify(): ReturnType<typeof createPayerVerify> {
  if (!runtime) {
    const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    runtime = createPayerVerify({
      db,
      sendCode: (phone, code) => sendSMS({ phone, message: SMSTemplates.verificationCode(code), type: "phone_otp" }),
      now: Date.now,
      randomCode: defaultPhoneOtpCode,
      rateLimit: botCapDeps(db).limit,
    })
  }
  return runtime
}

/** SMS a verification code to the paying number. Never throws. */
export async function sendPayerOtp(phone: string): Promise<SendPayerOtpResult> {
  return getPayerVerify().sendPayerOtp(phone)
}

/** Check the code the buyer typed for the paying number. Never throws. */
export async function verifyPayerOtp(phone: string, code: string): Promise<VerifyPayerOtpResult> {
  return getPayerVerify().verifyPayerOtp(phone, code)
}
