/**
 * Admin control for sms_accounts.review_hold. While it is set (and enforcement is on), every new
 * send of the account is held for review. record_sms_flags sets it automatically once the account's
 * OPEN flags reach the review threshold; this is the audited way to clear (or place) it by hand.
 *
 * Clearing also dismisses the account's open INFO flags, so the very next flag does not re-trip the
 * threshold. Open fraud flags are left for the Flagged tab, and fraud_flag_count is never touched.
 */
import { createClient } from "@supabase/supabase-js"
import { writeAuditLog } from "./moderation-service"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ReviewHoldResult =
  /** flagsClosed: open info flags dismissed while clearing (null = that step failed; the hold is still cleared). */
  | { ok: true; changed: boolean; review_hold: boolean; flagsClosed: number | null }
  | { ok: false; error: string; notFound?: true }

export async function setReviewHold(adminId: string, accountId: string, hold: boolean): Promise<ReviewHoldResult> {
  if (!UUID_RE.test(accountId ?? "")) return { ok: false, error: "Invalid account id" }
  if (typeof hold !== "boolean") return { ok: false, error: "review_hold must be true or false" }

  const { data, error } = await supabaseAdmin.from("sms_accounts").select("id, user_id, review_hold").eq("id", accountId).maybeSingle()
  if (error) return { ok: false, error: "Could not look up the account" }
  const acct = data as { id: string; user_id: string | null; review_hold: boolean | null } | null
  if (!acct) return { ok: false, error: "Account not found", notFound: true }

  const current = acct.review_hold === true
  const noop: ReviewHoldResult = { ok: true, changed: false, review_hold: hold, flagsClosed: 0 }
  if (current === hold) return noop

  // Conditional on the value we read: a concurrent change makes this a no-op.
  const { data: upd, error: updErr } = await supabaseAdmin
    .from("sms_accounts")
    .update({ review_hold: hold, updated_at: new Date().toISOString() })
    .eq("id", accountId)
    .eq("review_hold", current)
    .select("id")
  if (updErr) return { ok: false, error: "Could not update the review hold" }
  if (!upd || (upd as unknown[]).length === 0) return noop

  let flagsClosed: number | null = 0
  if (!hold) {
    const { data: closed, error: flagErr } = await supabaseAdmin
      .from("sms_flags")
      .update({ status: "dismissed", resolved_by: adminId, resolved_at: new Date().toISOString() })
      .eq("sms_account_id", accountId)
      .eq("status", "open")
      .eq("severity", "info")
      .select("id")
    if (flagErr) {
      console.error("[SMS-ADMIN] review hold cleared but open info flags could not be dismissed:", flagErr.message)
      flagsClosed = null
    } else {
      flagsClosed = ((closed ?? []) as unknown[]).length
    }
  }

  await writeAuditLog(adminId, hold ? "sms_review_hold_set" : "sms_review_hold_clear", acct.user_id ?? null,
    { accountId, review_hold: current }, { accountId, review_hold: hold, flagsClosed })
    .catch((e) => console.error("[SMS-AUDIT] review hold audit failed:", e))
  return { ok: true, changed: true, review_hold: hold, flagsClosed }
}
