import { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { GENERIC_LOGIN_ERROR, LIMITS } from "@/lib/phone-login/core"

export const DEVICE_COOKIE = "dg_device"
export const CHALLENGE_COOKIE = "dg_plc"

const NO_STORE = { "Cache-Control": "no-store" }

/** Every phone-login response goes through here so none is ever cached. */
export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE })
}

/** Byte-identical for every step-1 failure kind (and bad bodies). */
export function genericFail(): NextResponse {
  return json({ error: GENERIC_LOGIN_ERROR }, 401)
}

export function unavailable(): NextResponse {
  return json({ error: "Phone sign-in is unavailable right now. Please use email." }, 503)
}

export function tooMany(): NextResponse {
  return json({ error: "Too many attempts. Please try again later." }, 429)
}

/** Fixed tag only: never the error, which may carry PII from the driver. */
export function logFlowError(): void {
  console.error("phone_login_error")
}

/** True when the request may proceed. Degraded without the Postgres fallback counts as denied. */
export async function ipAllowed(request: NextRequest, name: "phone_login" | "phone_login_verify"): Promise<boolean> {
  const lim = name === "phone_login" ? LIMITS.ipStep1 : LIMITS.ipVerify
  const r = await applyRateLimit(request, name, lim.max, lim.windowMs, undefined, { pgFallback: true })
  if (!r.allowed) return false
  if (r.degraded && !r.fallback) return false
  return true
}

export async function readBody(request: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const b = await request.json()
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const COOKIE_BASE = { httpOnly: true, secure: true, sameSite: "lax", path: "/" } as const

export function setChallengeCookie(res: NextResponse, secret: string): void {
  res.cookies.set(CHALLENGE_COOKIE, secret, { ...COOKIE_BASE, maxAge: 600 })
}

export function clearChallengeCookie(res: NextResponse): void {
  res.cookies.set(CHALLENGE_COOKIE, "", { ...COOKIE_BASE, maxAge: 0 })
}

export function setDeviceCookie(res: NextResponse, token: string): void {
  res.cookies.set(DEVICE_COOKIE, token, { ...COOKIE_BASE, maxAge: 2_592_000 })
}
