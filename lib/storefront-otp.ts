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

// One-time verification: a phone that has EVER completed an OTP verification is
// trusted for all future orders. The OTP gate exists to make each phone prove
// itself once (stops anonymous mass automation); per-phone order caps (5/hr)
// bound volume thereafter. Repeat customers never re-verify.

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

// ── Wallet / upgrade payment gate ──────────────────────────────────────────
// Independent of the storefront gate. The order-free payment paths (wallet
// top-up, dealer upgrade) reach a hosted Paystack checkout that, via the
// mobile_money channel, lets ANY signed-in account type ANY number and fire a
// MoMo prompt at it — the prompt-spam vector, with no order/beneficiary to bind
// it. This toggle locks those paths down (the route drops mobile_money + caps
// per user) without touching the storefront flow. Separate switch so an admin
// can protect top-ups/upgrades during an attack while leaving normal shop
// checkout — or vice-versa — exactly as they want.
let walletGateCache: { enabled: boolean; expiresAt: number } | null = null

export async function isWalletOtpRequired(): Promise<boolean> {
  if (walletGateCache && walletGateCache.expiresAt > Date.now()) return walletGateCache.enabled
  if (!supabase) return false

  try {
    const { data } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", "wallet_otp_required")
      .maybeSingle()

    const enabled = data?.value?.enabled === true // default off unless explicitly true
    walletGateCache = { enabled, expiresAt: Date.now() + CACHE_TTL_MS }
    return enabled
  } catch {
    return false // fail open — never block payments on a DB hiccup
  }
}

export function invalidateWalletOtpCache(): void {
  walletGateCache = null
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
 * Is this phone trusted for checkout? True if EITHER:
 *   (a) it completed an OTP verification (phone_otp_verifications, used=true), OR
 *   (b) it has a COMPLETED, PAID order in its history (grandfathered).
 *
 * (b) auto-trusts existing customers who bought before the OTP gate existed —
 * a paid+completed order is a proven legit customer, and the attacker's flood
 * orders are never paid, so they're never grandfathered. One-time: once
 * trusted, always trusted; per-phone caps bound volume thereafter.
 */
export async function isPhoneVerified(phone: string): Promise<boolean> {
  if (!supabase) return false
  if (!phone) return false

  const variants = phoneVariants(phone)
  try {
    const [otp, shopOrder, airtimeOrder, rcOrder] = await Promise.all([
      supabase
        .from("phone_otp_verifications")
        .select("id", { count: "exact", head: true })
        .in("phone", variants).eq("used", true),
      // Past PAID data order (the bulk of business + the attack target)
      supabase
        .from("shop_orders")
        .select("id", { count: "exact", head: true })
        .in("customer_phone", variants).eq("payment_status", "completed"),
      // Past PAID airtime to this number (gate verifies beneficiary phone)
      supabase
        .from("airtime_orders")
        .select("id", { count: "exact", head: true })
        .in("beneficiary_phone", variants).eq("payment_status", "completed"),
      // Past PAID results-checker order
      supabase
        .from("results_checker_orders")
        .select("id", { count: "exact", head: true })
        .in("customer_phone", variants).eq("payment_status", "completed"),
    ])
    return (otp.count ?? 0) > 0
      || (shopOrder.count ?? 0) > 0
      || (airtimeOrder.count ?? 0) > 0
      || (rcOrder.count ?? 0) > 0
  } catch {
    return false
  }
}
