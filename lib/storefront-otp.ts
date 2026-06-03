import { createClient } from "@supabase/supabase-js"
import { logSecurityEvent } from "./security-log"
import { phoneVariants } from "./phone-format"

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
  if (!supabase) return enabledCache?.enabled ?? false

  try {
    const { data, error } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", "storefront_otp_required")
      .maybeSingle()
    if (error) throw error

    const enabled = data?.value?.enabled === true // default off unless explicitly true
    enabledCache = { enabled, expiresAt: Date.now() + CACHE_TTL_MS }
    return enabled
  } catch {
    // Fail to LAST-KNOWN STATE, not open: a transient DB error during an attack
    // must not silently drop the gate. If the gate was ON 30s ago, keep it ON.
    // Only when we've never successfully read it do we default OFF.
    if (enabledCache) {
      logSecurityEvent("gate_read_failed_using_cache", { gate: "storefront_otp", cached: enabledCache.enabled })
      return enabledCache.enabled
    }
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
  if (!supabase) return walletGateCache?.enabled ?? false

  try {
    const { data, error } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", "wallet_otp_required")
      .maybeSingle()
    if (error) throw error

    const enabled = data?.value?.enabled === true // default off unless explicitly true
    walletGateCache = { enabled, expiresAt: Date.now() + CACHE_TTL_MS }
    return enabled
  } catch {
    // Fail to LAST-KNOWN STATE (see isStorefrontOtpRequired) — a DB blip during
    // an attack must not silently re-open the order-free MoMo path.
    if (walletGateCache) {
      logSecurityEvent("gate_read_failed_using_cache", { gate: "wallet_otp", cached: walletGateCache.enabled })
      return walletGateCache.enabled
    }
    return false
  }
}

export function invalidateWalletOtpCache(): void {
  walletGateCache = null
}

// ── Phone-gate kill switch ──────────────────────────────────────────────────
// The dashboard hard-blocks any logged-in user with no phone number (non-
// dismissable modal). Its ONLY escape is OTP verification — so if SMS delivery
// fails, users get locked out. This admin flag (admin_settings key
// 'phone_gate_disabled') is the emergency off-switch: set it and the gate
// vanishes within ~30s, no deploy. Default OFF (gate enforced).
let phoneGateCache: { disabled: boolean; expiresAt: number } | null = null

export async function isPhoneGateDisabled(): Promise<boolean> {
  if (phoneGateCache && phoneGateCache.expiresAt > Date.now()) return phoneGateCache.disabled
  if (!supabase) return false
  try {
    const { data } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", "phone_gate_disabled")
      .maybeSingle()
    const disabled = data?.value?.disabled === true
    phoneGateCache = { disabled, expiresAt: Date.now() + CACHE_TTL_MS }
    return disabled
  } catch {
    return false // gate stays enforced on a DB hiccup
  }
}

export function invalidatePhoneGateCache(): void {
  phoneGateCache = null
}

// Phone-format variants (0XXXXXXXXX vs 233XXXXXXXXX vs +233...) now come from the
// shared lib/phone-format helper so every flow matches numbers identically.

/**
 * STRICT verification — true ONLY if this exact phone completed an SMS OTP
 * (phone_otp_verifications.used = true). Unlike isPhoneVerified, a past paid
 * order does NOT count.
 *
 * Use this to authorise anything that CHARGES or PROMPTS a number: we must have
 * fresh, explicit consent for THAT specific number, not merely "it bought once".
 * The grandfather rule (isPhoneVerified) was being abused — an attacker reused a
 * single previously-paid number to mint valid orders and to direct-charge other
 * past customers. Requiring a real OTP closes both. Fails CLOSED on any error.
 */
export async function isPhoneOtpVerified(phone: string): Promise<boolean> {
  if (!supabase) return false
  if (!phone) return false
  const variants = phoneVariants(phone)
  try {
    const { count } = await supabase
      .from("phone_otp_verifications")
      .select("id", { count: "exact", head: true })
      .in("phone", variants)
      .eq("used", true)
    return (count ?? 0) > 0
  } catch {
    return false
  }
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
