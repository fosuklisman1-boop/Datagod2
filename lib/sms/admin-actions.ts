/** Admin account actions that move money-like state (Phase 2). Credits are solvency-gated via allocateUnits. */
import { createClient } from "@supabase/supabase-js"
import { allocateUnits } from "./bundle-service"
import { writeAuditLog } from "./moderation-service"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
export const MAX_ALLOCATION = 1_000_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type AllocateResult =
  | { ok: true; pending: boolean; unitsCredited: number; duplicate?: boolean }
  | { ok: false; error: string }

/** requestId (optional UUID) makes a retry idempotent: a repeat credits nothing and writes no second audit row. */
export async function allocateCredits(adminId: string, accountId: string, units: number, requestId?: string): Promise<AllocateResult> {
  if (!adminId) return { ok: false, error: "Admin user required" }
  if (!UUID_RE.test(accountId)) return { ok: false, error: "Invalid account id" }
  if (!Number.isInteger(units) || units < 1 || units > MAX_ALLOCATION) {
    return { ok: false, error: `Credits must be a whole number from 1 to ${MAX_ALLOCATION.toLocaleString("en-US")}` }
  }
  if (requestId !== undefined && !UUID_RE.test(requestId)) return { ok: false, error: "Invalid request id" }

  const { data: acct, error: acctErr } = await supabaseAdmin.from("sms_accounts").select("id, user_id").eq("id", accountId).maybeSingle()
  if (acctErr) return { ok: false, error: "Could not look up the account" }
  if (!acct) return { ok: false, error: "Account not found" }

  const r = await allocateUnits(accountId, units, requestId ? `admin_alloc:${requestId}` : null)
  if (!r.ok) return { ok: false, error: r.error ?? "Allocation failed" }
  if (r.outcome === "duplicate") return { ok: true, pending: false, unitsCredited: 0, duplicate: true }
  await writeAuditLog(adminId, "sms_credits_allocate", (acct as { user_id?: string }).user_id ?? null, null,
    { accountId, units, pending: r.pending ?? false, ...(requestId ? { requestId } : {}) })
    .catch((e) => console.error("[SMS-AUDIT] credits allocate audit failed:", e))
  return { ok: true, pending: r.pending ?? false, unitsCredited: r.unitsCredited ?? 0 }
}
