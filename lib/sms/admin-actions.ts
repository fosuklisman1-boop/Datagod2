/** Admin account actions that move money-like state (Phase 2). Credits are solvency-gated via allocateUnits. */
import { createClient } from "@supabase/supabase-js"
import { allocateUnits } from "./bundle-service"
import { writeAuditLog } from "./moderation-service"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
export const MAX_ALLOCATION = 1_000_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type AllocateResult = { ok: true; pending: boolean; unitsCredited: number } | { ok: false; error: string }

export async function allocateCredits(adminId: string, accountId: string, units: number): Promise<AllocateResult> {
  if (!adminId) return { ok: false, error: "Admin user required" }
  if (!UUID_RE.test(accountId)) return { ok: false, error: "Invalid account id" }
  if (!Number.isInteger(units) || units < 1 || units > MAX_ALLOCATION) {
    return { ok: false, error: `Credits must be a whole number from 1 to ${MAX_ALLOCATION.toLocaleString("en-US")}` }
  }
  const r = await allocateUnits(accountId, units)
  if (!r.ok) return { ok: false, error: r.error ?? "Allocation failed" }
  const { data } = await supabaseAdmin.from("sms_accounts").select("user_id").eq("id", accountId).maybeSingle()
  await writeAuditLog(adminId, "sms_credits_allocate", (data as { user_id?: string } | null)?.user_id ?? null, null,
    { accountId, units, pending: r.pending ?? false }).catch(() => {})
  return { ok: true, pending: r.pending ?? false, unitsCredited: r.unitsCredited ?? 0 }
}
