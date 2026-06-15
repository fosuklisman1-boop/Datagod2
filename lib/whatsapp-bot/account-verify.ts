// lib/whatsapp-bot/account-verify.ts
//
// OTP ownership check so a customer messaging from a non-account number can link
// their Datagod account in chat. A 6-digit code is sent (SMS) to the account's
// REGISTERED number — only the real owner receives it — and must be entered back.
// Reuses the existing phone_otp_verifications table + sms-service. The in-flight
// challenge lives in Redis keyed by the WhatsApp sender.
import { createClient } from "@supabase/supabase-js"
import { Redis } from "@upstash/redis"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import { phoneVariants } from "@/lib/phone-format"
import { linkWhatsAppToAccount } from "./account-link"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

let redis: Redis | null = null
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  }
} catch { /* no redis → verification unavailable, handled by callers */ }

const CHALLENGE_TTL_S = 600          // 10 min
const MAX_ATTEMPTS = 5
const SEND_CAP_PER_SENDER = 3        // codes a single WhatsApp number can trigger per hour
const SEND_CAP_WINDOW_S = 3600

interface Challenge { userId: string; targetPhone: string; attempts: number }

const chKey = (waPhone: string) => `wa:acctverify:${waPhone}`
const sendCountKey = (waPhone: string) => `wa:acctverify:sendcount:${waPhone}`

export interface StartResult { ok: boolean; reason?: "not_found" | "rate_limited" | "no_redis" | "error"; maskedPhone?: string }

export async function startAccountVerification(waPhone: string, accountNumber: string): Promise<StartResult> {
  try {
    if (!redis) return { ok: false, reason: "no_redis" }
    const variants = phoneVariants(accountNumber)
    if (!variants.length) return { ok: false, reason: "not_found" }

    const { data: user } = await supabase
      .from("users")
      .select("id, phone_number")
      .in("phone_number", variants)
      .maybeSingle()
    if (!user?.id || !user.phone_number) return { ok: false, reason: "not_found" }

    // Per-sender cap: stops one WhatsApp number SMS-bombing / enumerating accounts.
    const n = await redis.incr(sendCountKey(waPhone))
    if (n === 1) await redis.expire(sendCountKey(waPhone), SEND_CAP_WINDOW_S)
    if (n > SEND_CAP_PER_SENDER) return { ok: false, reason: "rate_limited" }

    // Per-target cap: max 3 codes/hr to the account's number (mirrors send-phone-otp).
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString()
    const { count } = await supabase
      .from("phone_otp_verifications")
      .select("id", { count: "exact", head: true })
      .eq("phone", user.phone_number)
      .gte("created_at", oneHourAgo)
    if ((count ?? 0) >= 3) return { ok: false, reason: "rate_limited" }

    const code = Math.floor(100000 + Math.random() * 900000).toString()
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_S * 1000).toISOString()
    await supabase
      .from("phone_otp_verifications")
      .insert({ phone: user.phone_number, code, expires_at: expiresAt, purpose: "wa_account_link" })

    // Carry forward any existing attempt count so re-sending a code can't reset
    // the brute-force counter (a new challenge would otherwise start at 0).
    const existing = await redis.get<Challenge>(chKey(waPhone))
    const challenge: Challenge = { userId: user.id, targetPhone: user.phone_number, attempts: existing?.attempts ?? 0 }
    await redis.setex(chKey(waPhone), CHALLENGE_TTL_S, JSON.stringify(challenge))

    await sendSMS({ phone: user.phone_number, message: SMSTemplates.verificationCode(code), type: "phone_otp" }).catch(() => {})

    return { ok: true, maskedPhone: user.phone_number.slice(-4) }
  } catch (e) {
    console.error("[WA-ACCTVERIFY] start failed:", e)
    return { ok: false, reason: "error" }
  }
}

export interface VerifyResult { ok: boolean; reason?: "no_challenge" | "too_many" | "bad_code" | "error"; userId?: string }

export async function verifyAccountCode(waPhone: string, code: string): Promise<VerifyResult> {
  try {
    if (!redis) return { ok: false, reason: "error" }
    const challenge = await redis.get<Challenge>(chKey(waPhone))
    if (!challenge) return { ok: false, reason: "no_challenge" }

    if ((challenge.attempts ?? 0) >= MAX_ATTEMPTS) {
      await redis.del(chKey(waPhone))
      return { ok: false, reason: "too_many" }
    }

    const cleanCode = String(code).replace(/\D/g, "")
    const { data: match } = await supabase
      .from("phone_otp_verifications")
      .select("id")
      .eq("phone", challenge.targetPhone)
      .eq("code", cleanCode)
      .eq("purpose", "wa_account_link")
      .eq("used", false)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!match) {
      challenge.attempts = (challenge.attempts ?? 0) + 1
      await redis.setex(chKey(waPhone), CHALLENGE_TTL_S, JSON.stringify(challenge))
      return { ok: false, reason: "bad_code" }
    }

    // Single-use: the .eq("used", false) makes a concurrent duplicate a no-op.
    // The link target is the server-set challenge.userId either way, so linking
    // is idempotent and always to the correct account.
    await supabase.from("phone_otp_verifications").update({ used: true }).eq("id", match.id).eq("used", false)
    await linkWhatsAppToAccount(waPhone, challenge.userId)
    await redis.del(chKey(waPhone))
    return { ok: true, userId: challenge.userId }
  } catch (e) {
    console.error("[WA-ACCTVERIFY] verify failed:", e)
    return { ok: false, reason: "error" }
  }
}
