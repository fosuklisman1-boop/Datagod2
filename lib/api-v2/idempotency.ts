/**
 * Idempotency claim store for the Developer API v2 commission endpoints
 * (migration 0132). A claim on (user, kind, reference) is inserted BEFORE the
 * engine is called; the UNIQUE constraint is what stops a retry or concurrent
 * duplicate from reaching the engine twice. Money-critical: every function
 * is fail-safe (never throws) and every read is owner-scoped.
 */

import type { SupabaseLike } from "./store"

export type ClaimKind = "airtime" | "bill"

export type ClaimOutcome =
  | { kind: "claimed"; claimId: string }
  | { kind: "replay"; orderRef: string; response: unknown }
  | { kind: "conflict" }
  | { kind: "in_progress" }
  | { kind: "unknown" }
  | { kind: "error" }

const TABLE = "api_v2_idempotency"
const STALE_MS = 10 * 60 * 1000
const MAX_LIST = 30

export async function claimRequest(
  client: SupabaseLike,
  p: { userId: string; apiV2KeyId: string; kind: ClaimKind; reference: string; requestHash: string },
  now: () => number = Date.now
): Promise<ClaimOutcome> {
  try {
    const ins = await client
      .from(TABLE)
      .insert({
        user_id: p.userId,
        api_v2_key_id: p.apiV2KeyId,
        kind: p.kind,
        reference: p.reference,
        request_hash: p.requestHash,
        status: "in_progress",
      })
      .select("id")
      .single()
    if (!ins.error) {
      return typeof ins.data?.id === "string" && ins.data.id ? { kind: "claimed", claimId: ins.data.id } : { kind: "error" }
    }
    if (ins.error?.code !== "23505") return { kind: "error" }

    // Someone owns this reference: read it (owner-scoped) and decide. The engine is never called from here.
    const { data: row, error } = await client
      .from(TABLE)
      .select("id, request_hash, status, order_ref, response, created_at")
      .eq("user_id", p.userId)
      .eq("kind", p.kind)
      .eq("reference", p.reference)
      .maybeSingle()
    if (error || !row) return { kind: "error" }

    if (row.request_hash !== p.requestHash) return { kind: "conflict" }
    switch (row.status) {
      case "done":
        if (typeof row.order_ref !== "string" || !row.order_ref || row.response === null || row.response === undefined) {
          return { kind: "error" }
        }
        return { kind: "replay", orderRef: row.order_ref, response: row.response }
      case "in_progress": {
        const created = Date.parse(row.created_at)
        // An unreadable timestamp fails safe: treat as unknown (blocks the reference, never re-runs the engine).
        if (!Number.isFinite(created) || now() - created > STALE_MS) return { kind: "unknown" }
        return { kind: "in_progress" }
      }
      case "unknown":
        return { kind: "unknown" }
      default:
        return { kind: "error" }
    }
  } catch {
    return { kind: "error" }
  }
}

/** in_progress -> done. False when the claim is not (or no longer) in_progress. */
export async function completeClaim(
  client: SupabaseLike,
  claimId: string,
  orderRef: string,
  response: unknown
): Promise<boolean> {
  try {
    // The DB requires order_ref AND response on a done row; refuse here rather than issue a doomed update.
    if (typeof orderRef !== "string" || !orderRef || response === null || response === undefined) return false
    const { data, error } = await client
      .from(TABLE)
      .update({ status: "done", order_ref: orderRef, response, completed_at: new Date().toISOString() })
      .eq("id", claimId)
      .eq("status", "in_progress")
      .select("id")
    return !error && Array.isArray(data) && data.length === 1
  } catch {
    return false
  }
}

/** Deletes the claim ONLY while it is in_progress (a no-charge engine failure frees the reference). */
export async function releaseClaim(client: SupabaseLike, claimId: string): Promise<boolean> {
  try {
    const { data, error } = await client
      .from(TABLE)
      .delete()
      .eq("id", claimId)
      .eq("status", "in_progress")
      .select("id")
    return !error && Array.isArray(data) && data.length === 1
  } catch {
    return false
  }
}

/** in_progress -> unknown: the outcome is ambiguous; the row keeps blocking the reference. */
export async function markClaimUnknown(client: SupabaseLike, claimId: string): Promise<boolean> {
  try {
    const { data, error } = await client
      .from(TABLE)
      .update({ status: "unknown" })
      .eq("id", claimId)
      .eq("status", "in_progress")
      .select("id")
    return !error && Array.isArray(data) && data.length === 1
  } catch {
    return false
  }
}

export async function getClaimByReference(
  client: SupabaseLike,
  userId: string,
  kind: ClaimKind,
  reference: string
): Promise<{ orderRef: string | null; status: string; response: unknown } | null> {
  try {
    const { data, error } = await client
      .from(TABLE)
      .select("order_ref, status, response")
      .eq("user_id", userId)
      .eq("kind", kind)
      .eq("reference", reference)
      .maybeSingle()
    if (error || !data) return null
    return { orderRef: typeof data.order_ref === "string" ? data.order_ref : null, status: String(data.status), response: data.response ?? null }
  } catch {
    return null
  }
}

export async function listClaims(
  client: SupabaseLike,
  userId: string,
  kind: ClaimKind,
  limit = MAX_LIST
): Promise<{ reference: string; orderRef: string | null; status: string }[]> {
  try {
    const n = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), MAX_LIST) : MAX_LIST
    const { data, error } = await client
      .from(TABLE)
      .select("reference, order_ref, status")
      .eq("user_id", userId)
      .eq("kind", kind)
      .order("created_at", { ascending: false })
      .limit(n)
    if (error || !Array.isArray(data)) return []
    return data.slice(0, MAX_LIST).map((r: any) => ({
      reference: String(r.reference),
      orderRef: typeof r.order_ref === "string" ? r.order_ref : null,
      status: String(r.status),
    }))
  } catch {
    return []
  }
}
