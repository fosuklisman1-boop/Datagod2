// Server-side verification for Cloudflare Turnstile tokens.
// Read TURNSTILE_SECRET_KEY from env — never log or expose it.

import { createClient } from "@supabase/supabase-js"

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

export interface TurnstileResult {
  valid: boolean
  reason?: string
}

// In-memory cache for the enabled flag so we don't hit Supabase on every order.
// 30-second TTL means an admin toggle propagates within 30s — short enough to
// matter, long enough to avoid hammering the DB during a traffic spike.
let enabledCache: { enabled: boolean; expiresAt: number } | null = null
const CACHE_TTL_MS = 30_000

const supabaseSettings = process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL
  ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null

/**
 * Admin kill switch. Returns true unless an admin has explicitly disabled
 * Turnstile in admin_settings (e.g., during a Cloudflare outage or
 * secret-rotation incident). Defaults to ON for safety on first run.
 */
export async function isTurnstileEnabled(): Promise<boolean> {
  // Cached value still fresh?
  if (enabledCache && enabledCache.expiresAt > Date.now()) {
    return enabledCache.enabled
  }
  if (!supabaseSettings) return true // safe default if env not configured

  try {
    const { data } = await supabaseSettings
      .from("admin_settings")
      .select("value")
      .eq("key", "turnstile_enabled")
      .maybeSingle()

    // Missing row OR explicit { enabled: false } both work. Default = true.
    const enabled = data?.value?.enabled !== false
    enabledCache = { enabled, expiresAt: Date.now() + CACHE_TTL_MS }
    return enabled
  } catch (e) {
    // DB error — fail OPEN (let traffic through). Other layers still protect:
    // cookie binding, honeypot, atomic caps. Better than a Supabase blip taking
    // down every order on the platform.
    console.warn("[TURNSTILE] isTurnstileEnabled DB error — defaulting to enabled:", e instanceof Error ? e.message : e)
    return true
  }
}

/** Invalidate the cache — call after an admin toggle so the change takes effect immediately. */
export function invalidateTurnstileCache(): void {
  enabledCache = null
}

export async function verifyTurnstileToken(token: string | undefined | null, remoteIp?: string): Promise<TurnstileResult> {
  if (!token) return { valid: false, reason: "missing_token" }

  const secret = process.env.TURNSTILE_SECRET_KEY
  if (!secret) {
    console.error("[TURNSTILE] TURNSTILE_SECRET_KEY not configured — failing closed")
    return { valid: false, reason: "not_configured" }
  }

  try {
    const formData = new FormData()
    formData.append("secret", secret)
    formData.append("response", token)
    if (remoteIp) formData.append("remoteip", remoteIp)

    const res = await fetch(VERIFY_URL, { method: "POST", body: formData })
    if (!res.ok) return { valid: false, reason: `verify_http_${res.status}` }

    const data = (await res.json()) as { success: boolean; "error-codes"?: string[] }
    if (data.success) return { valid: true }

    const reason = data["error-codes"]?.join(",") || "unknown"
    return { valid: false, reason }
  } catch (e) {
    return { valid: false, reason: e instanceof Error ? e.message : "fetch_failed" }
  }
}

export function getRequestIp(headers: Headers): string | undefined {
  // Vercel-trusted IP only; cf-connecting-ip/x-real-ip/leftmost-xff are spoofable here.
  return (
    headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-forwarded-for")?.split(",").pop()?.trim() ||
    undefined
  )
}
