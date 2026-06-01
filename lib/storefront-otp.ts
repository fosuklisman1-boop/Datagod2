import { createClient } from "@supabase/supabase-js"

// Storefront checkout phone-OTP gate. When enabled (admin toggle), a shop order
// can only be placed for a phone that was recently verified via SMS OTP. This
// converts "anonymous unlimited guest checkout" into "one checkout per verified
// phone" — the #1 industry-recommended defense against card-testing / payment
// prompt abuse on guest checkout.

const supabase = process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL
  ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null

// How recently the phone must have been verified to count as "verified for checkout".
const VERIFIED_WINDOW_MINUTES = 30

// In-memory cache for the toggle (30s TTL) so we don't hit the DB on every order.
let enabledCache: { enabled: boolean; expiresAt: number } | null = null
const CACHE_TTL_MS = 30_000

/**
 * Admin toggle: is the storefront checkout OTP gate currently ON?
 * Defaults to FALSE (off) when the row is missing — enabling is a deliberate
 * admin action, since it adds an SMS step to every checkout.
 */
export async function isStorefrontOtpRequired(): Promise<boolean> {
  if (enabledCache && enabledCache.expiresAt > Date.now()) return enabledCache.enabled
  if (!supabase) return false

  try {
    const { data } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", "storefront_otp_required")
      .maybeSingle()

    const enabled = data?.value?.enabled === true // default off unless explicitly true
    enabledCache = { enabled, expiresAt: Date.now() + CACHE_TTL_MS }
    return enabled
  } catch {
    // Fail OPEN (don't block checkout on a DB hiccup). The gate is an
    // anti-abuse lever, not a correctness requirement.
    return false
  }
}

export function invalidateStorefrontOtpCache(): void {
  enabledCache = null
}

// Phone formats vary (0XXXXXXXXX vs 233XXXXXXXXX vs +233...). Build the
// candidate set so the verification lookup matches however it was stored.
function phoneVariants(phone: string): string[] {
  const digits = phone.replace(/\D/g, "")
  const local = digits.startsWith("233") ? "0" + digits.slice(3) : (digits.startsWith("0") ? digits : "0" + digits)
  const noZero = local.replace(/^0/, "")
  return Array.from(new Set([phone, local, noZero, "233" + noZero, "+233" + noZero]))
}

/**
 * Was this phone verified via OTP within the last VERIFIED_WINDOW_MINUTES?
 * Looks for a `used: true` phone_otp_verifications row created recently.
 */
export async function isPhoneRecentlyVerified(phone: string): Promise<boolean> {
  if (!supabase) return false
  if (!phone) return false

  const since = new Date(Date.now() - VERIFIED_WINDOW_MINUTES * 60 * 1000).toISOString()
  try {
    const { data } = await supabase
      .from("phone_otp_verifications")
      .select("id")
      .in("phone", phoneVariants(phone))
      .eq("used", true)
      .gte("created_at", since)
      .limit(1)
      .maybeSingle()
    return !!data
  } catch {
    return false
  }
}
