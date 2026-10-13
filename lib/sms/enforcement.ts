/**
 * Send-policy ENFORCEMENT (Phase 3b). Only used when settings.policyEnforced is true
 * (tenant_global_settings.sms_policy_enforced, default false); otherwise the send path is
 * exactly the record-only one.
 *
 * The policy is evaluated ONCE per user send, on the full recipient list, before batching
 * (controller decision 2026-10-11). Inputs are built by policy-context.evaluatePolicy, the same
 * builder the record-only shadow uses.
 *
 * Customer-facing output is ONLY the policy's `reason` text (written for customers). Flag
 * details (matched keywords / reasons) go to the database for admins and are never returned.
 */
import { createClient } from "@supabase/supabase-js"
import { buildShadow, evaluatePolicy, type PolicyArgs, type PolicyShadow } from "./policy-context"
import { loadSmsSettings, type SmsMode, type SmsPlatformSettings } from "./platform-settings"
import type { PolicyCode, PolicyFlag, PolicyResult } from "./policy"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

/** An enforced evaluation that does not answer in time fails CLOSED (nothing sent or charged). */
export const ENFORCE_TIMEOUT_MS = 10_000
export const POLICY_UNAVAILABLE_REASON = "We couldn't check this send right now. Nothing was charged — please try again in a minute."

export type EnforcementCode = PolicyCode | "POLICY_UNAVAILABLE"
type Thresholds = Pick<SmsPlatformSettings, "autoSuspendFlags" | "flagReviewThreshold">

export type EnforcementOutcome =
  | { kind: "allow" | "hold"; mode: SmsMode; shadow: PolicyShadow; thresholds: Thresholds }
  | { kind: "block"; mode: SmsMode; shadow: PolicyShadow; code: PolicyCode; reason: string; fraudFlags: PolicyFlag[]; thresholds: Thresholds }
  | { kind: "reject"; code: EnforcementCode; reason: string }

/** Generic customer text for a block whose reason is internal (the legacy content filter's rule names). */
export const BLOCKED_SAFE_REASON = "This message contains content we can't send."

/**
 * The reason a route may show the customer for BLOCKED. Only an enforced policy block (which
 * carries `code`) has customer-written text; the legacy filter's reason is a rule name
 * (e.g. "credential-harvest: pin") and stays server-side in sms_send_logs.flag_reason.
 */
export function customerBlockedReason(r: { code?: string; reason?: string }): string {
  return r.code && r.reason?.trim() ? r.reason : BLOCKED_SAFE_REASON
}

// ── Per-account send lease (migration 20261013_sms_policy_enforcement_2.sql) ──────────────────
// Usage (sms_account_usage) only counts a send once its log row exists, so parallel sends would
// all read the same usage and pass the caps together. Enforced sends therefore hold a short
// per-account lease from before the policy read until their last log row is written.
/**
 * Lease length. The lease must outlive the whole send, or a parallel send could take it while
 * this one is still writing log rows (each 500-recipient batch dispatches before the next
 * batch's log exists). The send routes cap a request at maxDuration = 300 s
 * (app/api/shop/sms/send, app/api/v1/sms/send), so 300 s + 30 s margin. Normally released far
 * earlier, in a finally; the expiry only matters if the function instance dies mid-send.
 */
export const SEND_LOCK_SECONDS = 330
export const SEND_IN_PROGRESS_MESSAGE = "Another send from your account is still being processed. Please try again in a few seconds."

export type SendLock = { status: "acquired"; token: string } | { status: "busy" } | { status: "error" }

/**
 * Take the per-account lease. The DB returns a fresh owner token, or NULL when another send holds
 * it. "error" (RPC failure) must make the caller fail CLOSED. Never throws.
 */
export async function trySendLock(accountId: string): Promise<SendLock> {
  try {
    const { data, error } = await supabaseAdmin.rpc("sms_try_send_lock", { p_account_id: accountId, p_seconds: SEND_LOCK_SECONDS })
    if (error) {
      console.error("[SMS-ENFORCE] sms_try_send_lock failed; refusing the send:", error.message)
      return { status: "error" }
    }
    return typeof data === "string" && data.length > 0 ? { status: "acquired", token: data } : { status: "busy" }
  } catch (e) {
    console.error("[SMS-ENFORCE] sms_try_send_lock threw; refusing the send:", e)
    return { status: "error" }
  }
}

/**
 * Release the lease — only if `token` still owns it (enforced in SQL). Best-effort: on failure
 * the lease expires after SEND_LOCK_SECONDS. Never throws.
 */
export async function releaseSendLock(accountId: string, token: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin.rpc("sms_release_send_lock", { p_account_id: accountId, p_token: token })
    if (error) console.error("[SMS-ENFORCE] sms_release_send_lock failed (lease will expire):", error.message)
  } catch (e) {
    console.error("[SMS-ENFORCE] sms_release_send_lock threw (lease will expire):", e)
  }
}

/** HTTP status for a POLICY_REJECTED send: 503 when it's a temporary outage, else 400. */
export function policyRejectedStatus(code: EnforcementCode | undefined): 400 | 503 {
  return code === "FEATURE_DISABLED" || code === "POLICY_UNAVAILABLE" ? 503 : 400
}

/** settings.policyEnforced (cached 60 s by loadSmsSettings, which never throws). */
export async function isPolicyEnforced(): Promise<boolean> {
  return (await loadSmsSettings()).policyEnforced === true
}

/** Pure: map a policy result to what the send path must do. */
export function decideOutcome(r: PolicyResult, mode: SmsMode, thresholds: Thresholds, now = new Date()): EnforcementOutcome {
  const shadow = buildShadow(r, true, now)
  const t: Thresholds = { autoSuspendFlags: thresholds.autoSuspendFlags, flagReviewThreshold: thresholds.flagReviewThreshold }
  switch (r.decision) {
    case "allow":
    case "hold":
      return { kind: r.decision, mode, shadow, thresholds: t }
    case "block":
      return {
        kind: "block", mode, shadow, code: r.code, reason: r.reason,
        fraudFlags: r.flags.filter((f) => f.severity === "fraud"),
        thresholds: t,
      }
    default: // reject | unavailable
      return { kind: "reject", code: r.code, reason: r.reason }
  }
}

const unavailable = (): EnforcementOutcome => ({ kind: "reject", code: "POLICY_UNAVAILABLE", reason: POLICY_UNAVAILABLE_REASON })

/** Evaluate for enforcement. Never throws; any failure (or a missing account / timeout) fails CLOSED. */
export async function evaluateForEnforcement(args: PolicyArgs, ms = ENFORCE_TIMEOUT_MS): Promise<EnforcementOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), ms) })
    const ev = await Promise.race([evaluatePolicy(args), timeout])
    if (ev === "timeout") {
      console.error("[SMS-ENFORCE] policy evaluation timed out; refusing the send")
      return unavailable()
    }
    if (!ev) {
      console.error("[SMS-ENFORCE] policy evaluation found no account; refusing the send")
      return unavailable()
    }
    return decideOutcome(ev.result, ev.mode, ev.settings)
  } catch (e) {
    console.error("[SMS-ENFORCE] policy evaluation failed; refusing the send:", e)
    return unavailable()
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Record policy flags (fraud and info) through the atomic DB function record_sms_flags
 * (migration 20261013_sms_policy_enforcement.sql): inserts one sms_flags row per flag,
 * increments fraud_flag_count by the fraud ones, auto-suspends at autoSuspendFlags and sets
 * review_hold once OPEN flags (any severity) reach flagReviewThreshold — all counting lives in
 * SQL. Never throws: a recording failure must not turn a block into a send, nor fail a paid send.
 */
export async function recordFlags(args: {
  accountId: string
  sendLogId: string | number | null
  flags: PolicyFlag[]
  thresholds: Thresholds
}): Promise<void> {
  const flags = args.flags.filter((f) => f.severity === "fraud" || f.severity === "info")
  if (flags.length === 0) return
  try {
    const { error } = await supabaseAdmin.rpc("record_sms_flags", {
      p_account_id: args.accountId,
      p_send_log_id: args.sendLogId,
      p_flags: flags,
      p_auto_suspend: args.thresholds.autoSuspendFlags,
      p_review_threshold: args.thresholds.flagReviewThreshold,
    })
    if (error) console.error("[SMS-ENFORCE] record_sms_flags failed:", error.message)
  } catch (e) {
    console.error("[SMS-ENFORCE] record_sms_flags threw:", e)
  }
}
