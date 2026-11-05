// Gateway choice shared by the SMS payment starts (credits, bundles, activation).
//
// SMS purchases carry no customer fee on either gateway: Paystack has always been charged the plain price, and the
// handler checks only that the amount paid covers the price. So a fallback charges the same amount and re-prices
// nothing, and there is no payment row to update: the metadata and the reference are the whole record.
import type { SupabaseClient } from "@supabase/supabase-js"
import { detectMomoProvider } from "@/lib/paystack"
import { isPhoneOtpVerified } from "@/lib/storefront-otp"
import { normalizeGhanaPhone } from "@/lib/phone-format"
import { isVerifiedWebPayer, momoPhoneText } from "@/lib/payment-gateway/initialize-gateway"
import { FallbackRefusedError, HostedStartError, resolveSurfaceGateway } from "@/lib/payment-gateway/start"
import { TRY_AGAIN_BODY } from "@/lib/payment-gateway/web-replay"
import type { Gateway } from "@/lib/payment-gateway/config"

export const SMS_SURFACE = "sms" as const

export type SmsDirectPlan =
  | { ok: true; gateway: Gateway; phone: string; provider: "mtn" | "vod" | "tgo" }
  | { ok: false; status: number; body: { error: string; code?: string } }

const OTP_REQUIRED = { ok: false as const, status: 403, body: { error: "Please verify your payment number to continue.", code: "OTP_REQUIRED" } }

/**
 * Which gateway a direct charge uses, and for which number. Hubtel gets the canonical number, and only after it has
 * proved itself even with the OTP gate off (no unsolicited prompts). A number with no canonical form is not Hubtel, and
 * Paystack keeps the value as typed.
 */
export async function planSmsDirect(
  db: SupabaseClient,
  o: { rawPhone: unknown; userId: string; otpRequired: boolean; amount?: number },
): Promise<SmsDirectPlan> {
  const typed = momoPhoneText(o.rawPhone)
  const canonical = normalizeGhanaPhone(typed)
  const canonicalProvider = canonical ? detectMomoProvider(canonical) : null
  if (canonical && canonicalProvider && (await resolveSurfaceGateway(SMS_SURFACE, { verifiedPayer: true, amount: o.amount })).gateway === "hubtel") {
    const verified = await isVerifiedWebPayer(canonical, {
      isPhoneOtpVerified,
      ownVerifiedPhone: async () => {
        const { data, error } = await db.from("users").select("phone_number, phone_verified").eq("id", o.userId).single()
        if (error || !data?.phone_verified) return null
        return (data.phone_number as string | null) ?? null
      },
    })
    if (!verified || (o.otpRequired && !(await isPhoneOtpVerified(canonical)))) return OTP_REQUIRED
    return { ok: true, gateway: "hubtel", phone: canonical, provider: canonicalProvider }
  }
  const provider = detectMomoProvider(typed)
  if (!provider) return { ok: false, status: 400, body: { error: "Could not detect the mobile money network from that number." } }
  if (o.otpRequired && !(await isPhoneOtpVerified(typed))) return OTP_REQUIRED
  return { ok: true, gateway: "paystack", phone: typed, provider }
}

/** The gateway a hosted start would use. `stripped`: MoMo must be off the hosted page, which only Paystack can do. */
export async function smsHostedGateway(stripped: boolean, amount?: number): Promise<Gateway> {
  if (stripped) return "paystack"
  return (await resolveSurfaceGateway(SMS_SURFACE, { verifiedPayer: true, amount })).gateway
}

/** The customer's answer when a start refuses; null for any other error, which the caller rethrows. */
export function smsStartRefusal(e: unknown): { status: number; body: { error: string; code?: string } } | null {
  if (e instanceof FallbackRefusedError) return { status: 503, body: TRY_AGAIN_BODY }
  if (e instanceof HostedStartError) return { status: e.code === "already_processing" ? 409 : 503, body: { error: e.message, code: e.code } }
  return null
}
