/**
 * Idempotency claim store for the Developer API v2 commission endpoints
 * (migration 0132). A claim on (user, kind, reference) is inserted BEFORE the
 * engine is called; the UNIQUE constraint is what stops a retry or concurrent
 * duplicate from reaching the engine twice. Money-critical: every function
 * is fail-safe (never throws) and every read is owner-scoped.
 */

import type { SupabaseLike } from "./store"

export type ClaimKind = "airtime" | "bill" | "results" | "afa"

export type ClaimOutcome =
  | { kind: "claimed"; claimId: string }
  | { kind: "replay"; orderRef: string; response: unknown }
  | { kind: "conflict" }
  | { kind: "in_progress" }
  | { kind: "unknown" }
  | { kind: "error" }

const TABLE = "api_v2_idempotency"
/**
 * An in_progress claim older than this reads as unknown (claimRequest, and
 * mapClaimState for the order lookups). INVARIANT: it must stay longer than
 * the longest maxDuration of any v2 purchase route (airtime purchase: 300 s),
 * so a claim whose request may still be running is never reported stale.
 */
export const CLAIM_STALE_MS = 10 * 60 * 1000
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
        if (!Number.isFinite(created) || now() - created > CLAIM_STALE_MS) return { kind: "unknown" }
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

/**
 * Guarded write: only the in_progress row with this id and, when userId is
 * given, owned by that user. Exactly one affected row means success.
 */
async function guardedWrite(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any,
  claimId: string,
  userId: string | undefined
): Promise<boolean> {
  let q = query.eq("id", claimId).eq("status", "in_progress")
  if (userId !== undefined) q = q.eq("user_id", userId)
  const { data, error } = await q.select("id")
  return !error && Array.isArray(data) && data.length === 1
}

/** in_progress -> done. False when the claim is not (or no longer) in_progress, or not the user's. */
export async function completeClaim(
  client: SupabaseLike,
  claimId: string,
  orderRef: string,
  response: unknown,
  now: () => number = Date.now,
  userId?: string
): Promise<boolean> {
  try {
    // The DB requires order_ref AND response on a done row; refuse here rather than issue a doomed update.
    if (typeof orderRef !== "string" || !orderRef || response === null || response === undefined) return false
    return await guardedWrite(
      client
        .from(TABLE)
        .update({ status: "done", order_ref: orderRef, response, completed_at: new Date(now()).toISOString() }),
      claimId,
      userId
    )
  } catch {
    return false
  }
}

/** Deletes the claim ONLY while it is in_progress (a no-charge engine failure frees the reference). */
export async function releaseClaim(client: SupabaseLike, claimId: string, userId?: string): Promise<boolean> {
  try {
    return await guardedWrite(client.from(TABLE).delete(), claimId, userId)
  } catch {
    return false
  }
}

/**
 * in_progress -> unknown: the outcome is ambiguous; the row keeps blocking the reference.
 * `orderRef` (optional): the engine's order when it supplied one (e.g. a bill whose debit
 * is uncertain), stored so support and the order lookup can resolve the real status.
 */
export async function markClaimUnknown(client: SupabaseLike, claimId: string, userId?: string, orderRef?: string): Promise<boolean> {
  try {
    const patch = typeof orderRef === "string" && orderRef ? { status: "unknown", order_ref: orderRef } : { status: "unknown" }
    return await guardedWrite(client.from(TABLE).update(patch), claimId, userId)
  } catch {
    return false
  }
}

export async function getClaimByReference(
  client: SupabaseLike,
  userId: string,
  kind: ClaimKind,
  reference: string
): Promise<{ orderRef: string | null; status: string; response: unknown; createdAt: string | null } | null> {
  try {
    const { data, error } = await client
      .from(TABLE)
      .select("order_ref, status, response, created_at")
      .eq("user_id", userId)
      .eq("kind", kind)
      .eq("reference", reference)
      .maybeSingle()
    if (error || !data) return null
    return {
      orderRef: typeof data.order_ref === "string" ? data.order_ref : null,
      status: String(data.status),
      response: data.response ?? null,
      createdAt: typeof data.created_at === "string" ? data.created_at : null,
    }
  } catch {
    return null
  }
}

/**
 * The owner's claims of one kind already linked to an engine order_ref (at
 * most 5). Used by the bill pay path to tell whether an order the engine
 * handed back belongs to another client reference. [] when none; null on a
 * read error (callers must not read null as "none").
 */
export async function findClaimByOrderRef(
  client: SupabaseLike,
  userId: string,
  kind: ClaimKind,
  orderRef: string
): Promise<{ reference: string; status: string }[] | null> {
  if (typeof orderRef !== "string" || !orderRef) return null
  try {
    const { data, error } = await client
      .from(TABLE)
      .select("reference, status")
      .eq("user_id", userId)
      .eq("kind", kind)
      .eq("order_ref", orderRef)
      .limit(5)
    if (error || !Array.isArray(data)) return null
    return data.slice(0, 5).map((r: any) => ({ reference: String(r.reference), status: String(r.status) }))
  } catch {
    return null
  }
}

export async function listClaims(
  client: SupabaseLike,
  userId: string,
  kind: ClaimKind,
  limit = MAX_LIST,
  /** `status`: filter in the query (so the limit counts only matching claims); default: every status. */
  opts: { status?: "in_progress" | "done" | "unknown" } = {}
  /** null on a read error (callers must fail closed, never read it as "no claims"). */
): Promise<{ reference: string; orderRef: string | null; status: string }[] | null> {
  try {
    const n = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), MAX_LIST) : MAX_LIST
    let q = client.from(TABLE).select("reference, order_ref, status").eq("user_id", userId).eq("kind", kind)
    if (opts.status) q = q.eq("status", opts.status)
    const { data, error } = await q
      .order("created_at", { ascending: false })
      // Tie-breaker: equal created_at values still list in a stable order.
      .order("id", { ascending: false })
      .limit(n)
    if (error || !Array.isArray(data)) return null
    return data.slice(0, MAX_LIST).map((r: any) => ({
      reference: String(r.reference),
      orderRef: typeof r.order_ref === "string" ? r.order_ref : null,
      status: String(r.status),
    }))
  } catch {
    return null
  }
}
