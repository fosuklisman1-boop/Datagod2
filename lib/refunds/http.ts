import { createClient } from "@supabase/supabase-js"
import { NextResponse } from "next/server"
import { RefundError, type RefundErrorCode, type Settled } from "./service"

export const refundDb = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export const REFUND_STATUS: Record<RefundErrorCode, number> = {
  NOT_FOUND: 404, NOT_ELIGIBLE: 409, ALREADY_REFUNDED: 409, ORDER_NOT_PENDING: 409,
  DISPATCH_ACTIVE: 409, SHORTFALL: 422, BAD_AMOUNT: 400, BAD_OTP: 400, GATEWAY_UNSUPPORTED: 400,
  RESERVE_FAILED: 500, SETTLE_FAILED: 500,
}

export function refundErrorResponse(err: unknown): NextResponse {
  if (err instanceof RefundError) {
    // detail is passed through unchanged (SETTLE_FAILED carries the gateway ref admins need).
    return NextResponse.json({ error: err.message, code: err.code, detail: err.detail }, { status: REFUND_STATUS[err.code] ?? 500 })
  }
  console.error("[REFUND] unexpected error:", err)
  return NextResponse.json({ error: "Refund request failed" }, { status: 500 })
}

export type RefundRoute = "execute" | "retry" | "otp" | "cancel" | "reconcile"

/**
 * HTTP status for a Settled result a route returned. A failed payout is 502, except on cancel where a returned
 * "failed" only means "cancelled and the clawback restored" (real problems throw).
 */
export const settledHttpStatus = (route: RefundRoute, status: Settled["status"]): number =>
  status === "failed" && route !== "cancel" ? 502 : 200

export const badRequest = (error: string) => NextResponse.json({ error, code: "BAD_REQUEST" }, { status: 400 })

/** Money-moving routes need a real signed-in admin (a CRON_SECRET caller has no userId). */
export function requireAdminUser(userId: string | undefined): NextResponse | null {
  return userId ? null : NextResponse.json({ error: "A signed-in admin is required", code: "ADMIN_REQUIRED" }, { status: 403 })
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v)

/** A finite number, or a plain numeric string that parses to one. Anything else -> null. */
export function parseAmount(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v)) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export function parseGateway(v: unknown): string | null {
  if (typeof v !== "string") return null
  const g = v.trim()
  return g.length > 0 && g.length <= 40 ? g : null
}

export const MAX_PAGE = 1000

/** Absent -> 1; a positive integer <= MAX_PAGE -> that; anything else -> null (caller returns 400). */
export function parsePage(v: string | null, max: number = MAX_PAGE): number | null {
  if (v === null || v === "") return 1
  if (!/^\d+$/.test(v)) return null
  const n = Number(v)
  return n >= 1 && n <= max ? n : null
}

/** Non-fatal admin_audit_log write. Never include OTPs or secrets in `newValue`. */
export async function auditRefund(
  db: ReturnType<typeof refundDb>, adminId: string | undefined, action: string, newValue: Record<string, unknown>,
): Promise<void> {
  if (!adminId) return // admin_id is NOT NULL
  try {
    const { error } = await db.from("admin_audit_log").insert({
      admin_id: adminId, action, target_user_id: null, old_value: null, new_value: newValue,
    })
    if (error) console.error("[REFUND] audit log failed (non-fatal):", error.message)
  } catch (e) {
    console.error("[REFUND] audit log threw (non-fatal):", e)
  }
}

/**
 * Records a failed money action in admin_audit_log as "<action>_error" when it matters for reconciliation
 * (SETTLE_FAILED, or any RefundError whose detail names a refundId). Non-fatal; never changes the response.
 */
export async function auditRefundError(
  db: ReturnType<typeof refundDb>, adminId: string | undefined, action: string, err: unknown, context: Record<string, unknown> = {},
): Promise<void> {
  if (!(err instanceof RefundError)) return
  const d = err.detail as { refundId?: unknown } | undefined
  if (err.code !== "SETTLE_FAILED" && !(d && typeof d === "object" && d.refundId)) return
  await auditRefund(db, adminId, `${action}_error`, { ...context, code: err.code, error: err.message, detail: err.detail ?? null })
}

/** Loads a stored refund by id for the [id] routes. Throws RefundError NOT_FOUND. */
export async function loadStoredRefund(db: ReturnType<typeof refundDb>, id: string) {
  const { data, error } = await db.from("order_refunds").select("*").eq("id", id).maybeSingle()
  if (error) throw new Error(`[REFUND] load refund failed: ${error.message}`)
  if (!data) throw new RefundError("NOT_FOUND", "Refund not found")
  return data
}
