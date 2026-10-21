// SMS phone-OTP core shared by /api/auth/send-phone-otp, /api/auth/verify-phone-otp and the in-process bot payer
// verification (lib/bot-commission/payer-verify.ts). One table (phone_otp_verifications), one set of rules:
//
// - issue: at most 3 codes per exact phone string per hour (DB count), 6-digit code, 10-minute expiry, then the SMS.
// - check: the bump_otp_attempts() DB counter (fail closed when unavailable; reject above 6), then the newest unused,
//   unexpired row matching phone + code + purpose, which is marked used=true (isPhoneOtpVerified then passes).
//
// The routes keep their own request-scoped (IP) Upstash caps and HTTP mapping; callers add their own caps on top.
import { randomInt } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"

/** Codes per exact phone string per hour (send). */
export const PHONE_OTP_PER_PHONE_HOURLY_MAX = 3
export const PHONE_OTP_TTL_MS = 10 * 60 * 1000
/** bump_otp_attempts() max above which a verify is refused. */
export const PHONE_OTP_ATTEMPT_CAP = 6
/** The verify route's per-phone Upstash cap (name, max, window) and its key. */
export const PHONE_OTP_VERIFY_PHONE_LIMIT = { name: "verify_phone_otp_phone", max: 6, windowMs: 10 * 60 * 1000 } as const
export const phoneOtpVerifyLimitId = (phone: string): string => `otpv:${String(phone).replace(/\D/g, "")}`

export interface PhoneOtpDeps {
  /**
   * Service-role client.
   */
  db: SupabaseClient
  /**
   * Send the code by SMS: callers wire sendSMS({ phone, message: SMSTemplates.verificationCode(code), type:
   * "phone_otp" }) (kept out of this module so it does not load the SMS stack). A throw propagates to the caller.
   */
  sendCode(phone: string, code: string): Promise<unknown>
  now(): number
  /** 6-digit code. */
  randomCode(): string
}

/** 6-digit code (100000..999999) from the CSPRNG: same length/range the routes always issued. */
export const defaultPhoneOtpCode = (): string => randomInt(100000, 1000000).toString()

export type IssuePhoneOtpResult =
  | { ok: true; sms: unknown }
  | { ok: false; reason: "PHONE_LIMIT" | "INSERT_FAILED" }

/**
 * Per-phone cap, new row, SMS. A count error (count null) does not block (route behaviour). The SMS result is
 * returned as-is (the auth route ignores it); a throw from the count, the insert call or the SMS propagates.
 */
export async function issuePhoneOtp(d: PhoneOtpDeps, phone: string, purpose: string): Promise<IssuePhoneOtpResult> {
  const oneHourAgo = new Date(d.now() - 60 * 60 * 1000).toISOString()
  const { count } = await d.db
    .from("phone_otp_verifications")
    .select("*", { count: "exact", head: true })
    .eq("phone", phone)
    .gte("created_at", oneHourAgo)
  if (count !== null && count >= PHONE_OTP_PER_PHONE_HOURLY_MAX) return { ok: false, reason: "PHONE_LIMIT" }

  const code = d.randomCode()
  const expiresAt = new Date(d.now() + PHONE_OTP_TTL_MS).toISOString()
  const { error: insertError } = await d.db
    .from("phone_otp_verifications")
    .insert({ phone, code, expires_at: expiresAt, purpose })
  if (insertError) {
    console.error("[SEND-OTP] Insert error:", insertError)
    return { ok: false, reason: "INSERT_FAILED" }
  }

  const sms = await d.sendCode(phone, code)
  return { ok: true, sms }
}

/**
 * - `verified`: the code matched; that row is now used=true.
 * - `too_many_attempts`: the DB attempt counter is above the cap.
 * - `unavailable`: the DB attempt counter could not be bumped (fail closed).
 * - `invalid`: no unused, unexpired row for phone + code + purpose (wrong, expired, used or another purpose).
 */
export type CheckPhoneOtpResult = "verified" | "too_many_attempts" | "unavailable" | "invalid"

export async function checkPhoneOtp(
  d: Pick<PhoneOtpDeps, "db" | "now">, phone: string, code: string, purpose: string,
): Promise<CheckPhoneOtpResult> {
  // DB-backed brute-force cap: holds even when the Upstash caps fail open.
  let dbFallbackOk = false
  try {
    const { data: maxAttempts, error: bumpErr } = await d.db.rpc("bump_otp_attempts", { p_phone: phone })
    if (!bumpErr) {
      dbFallbackOk = true
      if (typeof maxAttempts === "number" && maxAttempts > PHONE_OTP_ATTEMPT_CAP) return "too_many_attempts"
    }
  } catch {
    // bump_otp_attempts unavailable: handled by the fail-closed check below.
  }
  if (!dbFallbackOk) {
    console.error("[VERIFY-OTP] DB attempt-cap fallback unavailable — failing closed")
    return "unavailable"
  }

  const now = new Date(d.now()).toISOString()
  const { data: record } = await d.db
    .from("phone_otp_verifications")
    .select("id")
    .eq("phone", phone)
    .eq("code", code)
    .eq("purpose", purpose)
    .eq("used", false)
    .gte("expires_at", now)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!record) return "invalid"

  await d.db
    .from("phone_otp_verifications")
    .update({ used: true })
    .eq("id", (record as { id: string }).id)
  return "verified"
}

/**
 * Is there still an unused, unexpired code for this phone + purpose? (Tells a wrong code from an expired one; the
 * auth route does not need it.) Throws on a DB error.
 */
export async function hasLivePhoneOtp(d: Pick<PhoneOtpDeps, "db" | "now">, phone: string, purpose: string): Promise<boolean> {
  const { data, error } = await d.db
    .from("phone_otp_verifications")
    .select("id")
    .eq("phone", phone)
    .eq("purpose", purpose)
    .eq("used", false)
    .gte("expires_at", new Date(d.now()).toISOString())
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return !!data
}
