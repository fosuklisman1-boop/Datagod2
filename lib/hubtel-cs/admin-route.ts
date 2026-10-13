import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { ghanaSignificant, isValidGhanaMobile } from "@/lib/phone-format"
import {
  HubtelDisabledError, HubtelDuplicateOrderError, HubtelNotConfiguredError, HubtelOutcomeUnknownError,
  HubtelPausedError, HubtelServiceDisabledError, HubtelValidationError,
} from "./errors"

/** Hard cap for the admin live smoke-test purchase. Lives here: Next route files may only export handlers/config. */
export const TEST_PURCHASE_MAX_GHS = 5

/** A rate-limited admin comes back with isAdmin true AND a 429 errorResponse: honour it. */
export async function requireAdmin(request: NextRequest): Promise<{ ok: true; userId?: string } | { ok: false; response: NextResponse }> {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin || errorResponse) {
    return { ok: false, response: errorResponse ?? NextResponse.json({ error: "Admin access required" }, { status: 403 }) }
  }
  return { ok: true, userId }
}

export function clampPage(sp: URLSearchParams): { limit: number; offset: number } {
  const n = (v: string | null, d: number) => { const x = Number.parseInt(v ?? "", 10); return Number.isFinite(x) ? x : d }
  return { limit: Math.min(100, Math.max(1, n(sp.get("limit"), 25))), offset: Math.max(0, n(sp.get("offset"), 0)) }
}

/** Airtime/data destinations are stored as 233XXXXXXXXX; map a user-typed phone to that form (else undefined). */
export function searchAlternate(q: string | null | undefined): string | undefined {
  const term = (q ?? "").trim()
  if (!term || !isValidGhanaMobile(term)) return undefined
  return "233" + ghanaSignificant(term)!
}

export const REF_PATTERN = /^[A-Za-z0-9_-]{1,100}$/
export const MAX_SEARCH_LEN = 100
export const MAX_NOTE_LEN = 500

export const isValidRef = (v: unknown): v is string => typeof v === "string" && REF_PATTERN.test(v)
export const clampSearch = (q: string | null | undefined): string | undefined => (q ? q.slice(0, MAX_SEARCH_LEN) : undefined)

/** Resolve note: non-empty string after trim, at most 500 chars. */
export function validateNote(v: unknown): { ok: true; note: string } | { ok: false; error: string } {
  if (typeof v !== "string" || !v.trim()) return { ok: false, error: "A note is required" }
  const note = v.trim()
  if (note.length > MAX_NOTE_LEN) return { ok: false, error: `Note must be at most ${MAX_NOTE_LEN} characters` }
  return { ok: true, note }
}

/** Test-purchase amount: a finite number or a non-empty numeric string; no booleans/arrays/objects. */
export function parseTestAmount(v: unknown): { ok: true; amount: number } | { ok: false; error: string } {
  const bad = { ok: false as const, error: `Test amount must be between 0.01 and ${TEST_PURCHASE_MAX_GHS}` }
  let n: number
  if (typeof v === "number") n = v
  else if (typeof v === "string" && v.trim() !== "") n = Number(v)
  else return bad
  if (!Number.isFinite(n) || n <= 0 || n > TEST_PURCHASE_MAX_GHS) return bad
  return { ok: true, amount: n }
}

/** The env-readiness gate applies whenever the resulting config is enabled (incl. mode changes while enabled). */
export const needsEnvGate = (patchEnabled: boolean | undefined, beforeEnabled: boolean): boolean => (patchEnabled ?? beforeEnabled) === true

export function describeError(e: unknown): { status: number; error: string } {
  if (e instanceof HubtelValidationError) return { status: 400, error: e.message }
  if (e instanceof HubtelOutcomeUnknownError) {
    return { status: 502, error: `The request to Hubtel may have been sent but its outcome could not be recorded (reference ${e.clientReference}). Do NOT retry; check this reference's status first.` }
  }
  if (e instanceof HubtelDuplicateOrderError) return { status: 409, error: e.message }
  if (e instanceof HubtelDisabledError || e instanceof HubtelServiceDisabledError || e instanceof HubtelPausedError) return { status: 409, error: (e as Error).message }
  if (e instanceof HubtelNotConfiguredError) return { status: 503, error: e.message }
  console.error("[hubtel-cs] admin route error:", e instanceof Error ? e.message : "unknown error")
  return { status: 500, error: "Internal error" }
}

export function errorJson(e: unknown): NextResponse {
  const d = describeError(e)
  return NextResponse.json({ error: d.error }, { status: d.status })
}

/** Fire-and-forget audit entry; never blocks or fails the request. */
export function auditLog(db: any, entry: { adminId?: string; action: string; oldValue?: unknown; newValue?: unknown }): void {
  if (!entry.adminId) {
    console.error(`[ADMIN-AUDIT] hubtel cs audit SKIPPED for ${entry.action}: no admin id on this identity`)
    return
  }
  Promise.resolve(db.from("admin_audit_log").insert([{
    admin_id: entry.adminId, action: entry.action, target_user_id: null,
    old_value: entry.oldValue ?? null, new_value: entry.newValue ?? null, created_at: new Date().toISOString(),
  }])).then(({ error }: { error: any }) => { if (error) console.warn("[ADMIN-AUDIT] hubtel cs log failed:", error.message) })
    .catch((e: any) => console.warn("[ADMIN-AUDIT] hubtel cs log threw:", e?.message ?? e))
}
