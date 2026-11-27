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

export interface TimingDeps {
  now: () => number
  sleep: (ms: number) => Promise<void>
  random: () => number
}

const realTiming: TimingDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
}

let timing: TimingDeps = realTiming

/** Tests only: swap the clock/sleep/random; pass null to restore the real ones. */
export function _setTimingDepsForTest(d: TimingDeps | null): void {
  timing = d ?? realTiming
}

export const STEP1_FLOOR_MS = 700
export const STEP1_JITTER_MS = 100

/** Request start, on the injectable clock. */
export function timingNow(): number {
  return timing.now()
}

/**
 * Pads the response so it leaves no sooner than `floorMs` (+ 0..jitterMs random) after `startMs`. Hides the gap
 * between a real bcrypt compare and the dummy check for an unknown number: EVERY step-1 outcome goes through it.
 */
export async function withTimingFloor(
  startMs: number,
  floorMs: number,
  jitterMs: number,
  deps: TimingDeps = timing,
): Promise<void> {
  const target = startMs + floorMs + deps.random() * jitterMs
  const remaining = target - deps.now()
  if (remaining > 0) await deps.sleep(remaining)
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
