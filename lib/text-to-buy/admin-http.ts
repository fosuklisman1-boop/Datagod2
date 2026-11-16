import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { verifyAdminAccess } from "@/lib/admin-auth"

// Shared plumbing of the Text-to-Buy admin routes: the admin gate, JSON responses and error logging.
// Responses can carry customer text and phone numbers, so every one is no-store. Errors log a route tag and a code only.

const TAG = "[TTB-ADMIN]"

export type Db = NonNullable<typeof supabaseAdmin>
export type Ctx = { db: Db; userId?: string }

/** JSON with Cache-Control: no-store. */
export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

export const fail = (error: string, status: number): NextResponse => json({ error }, status)

/** Route tag + database error code (sanitised) only. Never message text, numbers, reasons or setting values. */
export function logError(where: string, err: unknown): void {
  const e = (err && typeof err === "object" ? err : {}) as { code?: unknown }
  const code = typeof e.code === "string" ? e.code.replace(/[^A-Za-z0-9_]/g, "").slice(0, 20) : "-"
  console.error(`${TAG} ${where} failed code=${code}`)
}

/**
 * Admin gate. Not an admin: 403. Writes (and anything that shows customer text) also need a real admin user id: the cron
 * bearer passes verifyAdminAccess as an admin with no userId, and must not get through.
 */
export async function gate(request: NextRequest, needsUser: boolean): Promise<Ctx | NextResponse> {
  const auth = await verifyAdminAccess(request)
  if (auth.errorResponse) return auth.errorResponse
  if (!auth.isAdmin) return fail("Admin access required", 403)
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !supabaseAdmin) return fail("unavailable", 503)
  if (needsUser && !auth.userId) return fail("admin_user_required", 403)
  return { db: supabaseAdmin, userId: auth.userId }
}
export const isResponse = (x: Ctx | NextResponse): x is NextResponse => x instanceof Response

/** A JSON object body, or null when the body is missing, not JSON, or not a plain object. */
export async function readObject(request: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json()
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// "Try it" can cost an AI call, so each admin gets a small allowance. Per server instance and in memory (no Redis in this lane):
// it stops a stuck button or a loop, not a determined admin, which is the threat that matters here.
const TRY_MAX = 10
const TRY_WINDOW_MS = 60_000
const tryStamps = new Map<string, number[]>()

export function tryAllowed(userId: string, nowMs: number): boolean {
  const live = (tryStamps.get(userId) ?? []).filter((t) => nowMs - t < TRY_WINDOW_MS)
  if (live.length >= TRY_MAX) {
    tryStamps.set(userId, live)
    return false
  }
  live.push(nowMs)
  tryStamps.set(userId, live)
  if (tryStamps.size > 500) for (const [k, v] of tryStamps) if (v.every((t) => nowMs - t >= TRY_WINDOW_MS)) tryStamps.delete(k)
  return true
}

export function resetTryAllowance(): void {
  tryStamps.clear()
}
