import { createClient } from "@supabase/supabase-js"
import { logSecurityEvent } from "../security-log"
import { isStorefrontOtpRequired, isWalletOtpRequired } from "../storefront-otp"

// Legacy direct-charge toggles (admin_settings keys storefront_direct_charge /
// wallet_direct_charge), moved verbatim from lib/storefront-otp.ts. They are now only
// the fallback input to the payment-gateway config (see read-config.ts).
//
// Backward-compat: when a surface's own direct-charge row is ABSENT we inherit
// its OTP gate's value. Installs that today rely on the coupled gate (OTP on => direct
// charge on) keep that exact behavior until an admin sets the new toggle.

const supabase = process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL
  ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null

const CACHE_TTL_MS = 30_000

let storefrontDirectCache: { enabled: boolean; expiresAt: number } | null = null
let walletDirectCache: { enabled: boolean; expiresAt: number } | null = null

async function readDirectChargeGate(
  key: "storefront_direct_charge" | "wallet_direct_charge",
  cache: { enabled: boolean; expiresAt: number } | null,
  setCache: (c: { enabled: boolean; expiresAt: number }) => void,
  otpFallback: () => Promise<boolean>,
  gateLabel: string,
): Promise<boolean> {
  if (cache && cache.expiresAt > Date.now()) return cache.enabled
  if (!supabase) return cache?.enabled ?? (await otpFallback())

  try {
    const { data, error } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", key)
      .maybeSingle()
    if (error) throw error

    // Row absent -> inherit the OTP gate value (preserves the legacy coupled
    // behavior). Row present -> use its explicit boolean.
    const enabled = data ? data.value?.enabled === true : await otpFallback()
    const next = { enabled, expiresAt: Date.now() + CACHE_TTL_MS }
    setCache(next)
    return enabled
  } catch {
    // Fail to LAST-KNOWN STATE (see isStorefrontOtpRequired).
    if (cache) {
      logSecurityEvent("gate_read_failed_using_cache", { gate: gateLabel, cached: cache.enabled })
      return cache.enabled
    }
    return otpFallback()
  }
}

export async function readLegacyStorefrontDirectCharge(): Promise<boolean> {
  return readDirectChargeGate(
    "storefront_direct_charge",
    storefrontDirectCache,
    (c) => { storefrontDirectCache = c },
    isStorefrontOtpRequired,
    "storefront_direct_charge",
  )
}

export async function readLegacyWalletDirectCharge(): Promise<boolean> {
  return readDirectChargeGate(
    "wallet_direct_charge",
    walletDirectCache,
    (c) => { walletDirectCache = c },
    isWalletOtpRequired,
    "wallet_direct_charge",
  )
}

export function invalidateLegacyDirectChargeCaches(): void {
  storefrontDirectCache = null
  walletDirectCache = null
}
