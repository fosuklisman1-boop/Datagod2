// Kuntanii "bundle not received" disputes (spec §6).
//
// Filing is claim-first: a placeholder row is inserted BEFORE the API call so the
// partial unique index kuntanii_nr_one_open_per_tracking (open/escalated) turns a
// double-click or overlapping run into a 23505 -> 409, never a second dispute.
// Phone / size / external order id always come from the tracking row, never the
// request. Never logs phone numbers.

import { supabaseAdmin } from "@/lib/supabase"
import { createKuntaniiClient, type KuntaniiClient } from "./kuntanii-client"
import { toLocalGhanaPhone } from "./kuntanii-core"

export type DisputeStatus = "open" | "escalated" | "resolved" | "rejected"

/** Minimal structural type: the real Supabase client and the tests' fake both satisfy it. */
export interface SupabaseLike {
  from(table: string): any
}

export interface DisputeDeps {
  db?: SupabaseLike
  client?: KuntaniiClient
}

export const MAX_DESCRIPTION_CHARS = 500
export const MAX_REASON_CODE_CHARS = 50

const REPORTS = "kuntanii_not_received_reports"
const OPEN_STATUSES = ["open", "escalated"]

export function normaliseDisputeStatus(raw: string | undefined): DisputeStatus | null {
  if (typeof raw !== "string") return null
  const v = raw.trim().toLowerCase()
  return v === "open" || v === "escalated" || v === "resolved" || v === "rejected" ? v : null
}

export type FileResult =
  | { ok: true; reportReference: string; persisted?: false }
  | { ok: false; status: 400 | 404 | 409 | 502; error: string; code?: string }

export async function fileNotReceived(
  input: { trackingId: string; adminUserId: string; description?: string; reasonCode?: string },
  deps: DisputeDeps = {}
): Promise<FileResult> {
  const db = deps.db ?? (supabaseAdmin as SupabaseLike)

  if (input.description !== undefined && (typeof input.description !== "string" || input.description.length > MAX_DESCRIPTION_CHARS)) {
    return { ok: false, status: 400, error: `description must be at most ${MAX_DESCRIPTION_CHARS} characters` }
  }
  if (input.reasonCode !== undefined && (typeof input.reasonCode !== "string" || input.reasonCode.length > MAX_REASON_CODE_CHARS)) {
    return { ok: false, status: 400, error: `reasonCode must be at most ${MAX_REASON_CODE_CHARS} characters` }
  }

  const { data: tracking, error: loadErr } = await db
    .from("mtn_fulfillment_tracking")
    .select("id, provider, status, mtn_order_id, recipient_phone, size_gb")
    .eq("id", input.trackingId)
    .maybeSingle()
  if (loadErr) {
    console.error(`[KUNTANII-DISPUTES] tracking load failed for ${input.trackingId}:`, loadErr.message)
    return { ok: false, status: 502, error: "Could not load the order" }
  }
  if (!tracking) return { ok: false, status: 404, error: "Order not found" }
  if (tracking.provider !== "kuntanii") return { ok: false, status: 400, error: "Order was not fulfilled by Kuntanii" }
  if (tracking.status !== "completed") return { ok: false, status: 400, error: "Only completed orders can be disputed" }

  const externalOrderId = typeof tracking.mtn_order_id === "string" ? tracking.mtn_order_id : ""
  const phone = typeof tracking.recipient_phone === "string" ? toLocalGhanaPhone(tracking.recipient_phone) : null
  if (!externalOrderId || !phone) return { ok: false, status: 400, error: "Order has no valid recipient or provider reference" }
  const dataGb = tracking.size_gb == null ? undefined : Number(tracking.size_gb)

  // Claim first.
  const { data: claim, error: claimErr } = await db
    .from(REPORTS)
    .insert({
      tracking_id: tracking.id,
      external_order_id: externalOrderId,
      phone_number: phone,
      data_gb: dataGb ?? null,
      reason_code: input.reasonCode ?? null,
      description: input.description ?? null,
      dispute_status: "open",
      raised_by: input.adminUserId,
    })
    .select("id")
    .single()
  if (claimErr) {
    if ((claimErr as any).code === "23505") return { ok: false, status: 409, error: "A dispute is already open for this order" }
    console.error(`[KUNTANII-DISPUTES] claim insert failed for ${input.trackingId}:`, claimErr.message)
    return { ok: false, status: 502, error: "Could not record the dispute" }
  }
  const claimId: string = claim.id

  const client = deps.client ?? createKuntaniiClient()
  const release = async () => {
    const { error } = await db.from(REPORTS).delete().eq("id", claimId)
    if (error) console.error(`[KUNTANII-DISPUTES] could not remove claim ${claimId}:`, error.message)
  }
  // Outcome unknown: the claim stays (blocks refiling); sweepOrphanClaims reconciles it.
  const UNKNOWN: FileResult = {
    ok: false,
    status: 502,
    error: "Outcome unknown — do not refile; the claim will be reconciled automatically",
  }

  let res
  try {
    res = await client.reportNotReceived(externalOrderId, {
      phoneNumber: phone,
      dataGb,
      reasonCode: input.reasonCode,
      description: input.description,
    })
  } catch (e) {
    console.error(`[KUNTANII-DISPUTES] report call threw for ${externalOrderId}; claim ${claimId} kept:`, (e as Error).message)
    return UNKNOWN
  }

  if (!res.ok) {
    // Only a definite client-side rejection proves nothing was filed.
    if (res.network !== true && res.status >= 400 && res.status <= 499) {
      await release()
      return { ok: false, status: 502, error: "Kuntanii rejected the report", code: res.code }
    }
    console.error(`[KUNTANII-DISPUTES] report outcome unknown for tracking ${input.trackingId} (status ${res.status}); claim ${claimId} kept`)
    return UNKNOWN
  }

  // The dispute status is data.disputeStatus; data.status is the ORDER-level status.
  const disputeStatus = normaliseDisputeStatus(res.data.disputeStatus) ?? "open"
  const patch = {
    report_reference: res.data.reportReference,
    order_reference: res.data.orderReference ?? null,
    dispute_status: disputeStatus,
    updated_at: new Date().toISOString(),
  }
  let persisted = false
  for (let attempt = 0; attempt < 3 && !persisted; attempt++) {
    const { error: updErr } = await db.from(REPORTS).update(patch).eq("id", claimId)
    if (!updErr) persisted = true
  }
  if (!persisted) {
    // The dispute exists at Kuntanii; the claim row stays so nobody can double-file.
    console.error(
      `[KUNTANII-DISPUTES] CRITICAL: report ${res.data.reportReference} filed for tracking ${input.trackingId} but could not be saved after 3 attempts (claim ${claimId})`
    )
    return { ok: true, reportReference: res.data.reportReference, persisted: false }
  }
  return { ok: true, reportReference: res.data.reportReference }
}

export async function refreshDispute(reportId: string, deps: DisputeDeps = {}): Promise<DisputeStatus | null> {
  const db = deps.db ?? (supabaseAdmin as SupabaseLike)
  const { data: row, error } = await db
    .from(REPORTS)
    .select("id, external_order_id, report_reference, dispute_status")
    .eq("id", reportId)
    .maybeSingle()
  if (error || !row || !row.report_reference) return null

  const client = deps.client ?? createKuntaniiClient()
  let res
  try {
    res = await client.getNotReceivedStatus(row.external_order_id, row.report_reference)
  } catch (e) {
    console.error(`[KUNTANII-DISPUTES] status call threw for report ${reportId}:`, (e as Error).message)
    return null
  }
  if (!res.ok) return null

  const status = normaliseDisputeStatus(res.data.status)
  if (!status) console.warn(`[KUNTANII-DISPUTES] unrecognised dispute status "${String(res.data.status).slice(0, 40)}" for report ${reportId}`)
  const nowIso = new Date().toISOString()
  const patch: Record<string, unknown> = { last_checked_at: nowIso, updated_at: nowIso }
  if (status) patch.dispute_status = status
  const { error: updErr } = await db.from(REPORTS).update(patch).eq("id", reportId)
  if (updErr) {
    console.error(`[KUNTANII-DISPUTES] refresh update failed for report ${reportId}:`, updErr.message)
    return null
  }
  return status
}

async function refreshIds(ids: string[], deps: DisputeDeps): Promise<number> {
  let n = 0
  for (const id of ids) {
    try {
      if ((await refreshDispute(id, deps)) !== null) n++
    } catch (e) {
      console.error(`[KUNTANII-DISPUTES] refresh failed for report ${id}:`, (e as Error).message)
    }
  }
  return n
}

export async function refreshOpenDisputes(trackingId: string, deps: DisputeDeps = {}): Promise<void> {
  const db = deps.db ?? (supabaseAdmin as SupabaseLike)
  const { data, error } = await db
    .from(REPORTS)
    .select("id")
    .eq("tracking_id", trackingId)
    .in("dispute_status", OPEN_STATUSES)
    .not("report_reference", "is", null)
  if (error) throw new Error(`refreshOpenDisputes lookup failed: ${error.message}`)
  await refreshIds((data ?? []).map((r: { id: string }) => r.id), { ...deps, db })
}

export async function refreshStaleDisputes(limit: number, olderThanMs: number, deps: DisputeDeps = {}): Promise<number> {
  const db = deps.db ?? (supabaseAdmin as SupabaseLike)
  const cutoff = new Date(Date.now() - olderThanMs).toISOString()
  const { data, error } = await db
    .from(REPORTS)
    .select("id")
    .in("dispute_status", OPEN_STATUSES)
    .not("report_reference", "is", null)
    .or(`last_checked_at.is.null,last_checked_at.lt.${cutoff}`)
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(limit)
  if (error) throw new Error(`refreshStaleDisputes lookup failed: ${error.message}`)
  return refreshIds((data ?? []).map((r: { id: string }) => r.id), { ...deps, db })
}

/**
 * Reconciles placeholder claims whose outcome was never recorded (report_reference
 * still NULL after olderThanMs). Asks Kuntanii whether a report exists for the order:
 * none -> free the claim; some -> keep it, mark recovered (reference unknown).
 */
export async function sweepOrphanClaims(
  olderThanMs: number,
  limit: number,
  deps: DisputeDeps & { now?: () => number } = {}
): Promise<{ checked: number; freed: number; recovered: number }> {
  const db = deps.db ?? (supabaseAdmin as SupabaseLike)
  const now = deps.now ?? Date.now
  const cutoff = new Date(now() - olderThanMs).toISOString()
  const { data, error } = await db
    .from(REPORTS)
    .select("id, tracking_id, external_order_id")
    .is("report_reference", null)
    .in("dispute_status", OPEN_STATUSES)
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(limit)
  if (error) throw new Error(`sweepOrphanClaims lookup failed: ${error.message}`)

  const client = deps.client ?? createKuntaniiClient()
  const out = { checked: 0, freed: 0, recovered: 0 }
  for (const row of (data ?? []) as Array<{ id: string; tracking_id: string; external_order_id: string }>) {
    out.checked++
    try {
      const res = await client.getOrder(row.external_order_id)
      if (!res.ok) continue
      const withReport = (res.data.orders ?? []).find((o) => o.notReceivedStatus != null)
      if (!withReport) {
        const { error: delErr } = await db.from(REPORTS).delete().eq("id", row.id)
        if (!delErr) out.freed++
        else console.error(`[KUNTANII-DISPUTES] sweep could not free claim ${row.id}:`, delErr.message)
      } else {
        const nowIso = new Date(now()).toISOString()
        const { error: updErr } = await db
          .from(REPORTS)
          .update({
            dispute_status: normaliseDisputeStatus(withReport.notReceivedStatus as string) ?? "open",
            updated_at: nowIso,
            last_checked_at: nowIso,
          })
          .eq("id", row.id)
        if (updErr) {
          console.error(`[KUNTANII-DISPUTES] sweep could not update claim ${row.id}:`, updErr.message)
          continue
        }
        console.warn(`[KUNTANII-DISPUTES] recovered orphan claim for tracking ${row.tracking_id}: report reference unknown`)
        out.recovered++
      }
    } catch (e) {
      console.error(`[KUNTANII-DISPUTES] sweep check failed for claim ${row.id}:`, (e as Error).message)
    }
  }
  return out
}
