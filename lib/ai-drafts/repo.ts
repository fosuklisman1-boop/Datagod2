import type { SupabaseClient } from "@supabase/supabase-js"
import {
  OUTCOME_STATUSES,
  paramsSchemaFor,
  type AiDraft,
  type DraftAction,
  type DraftContext,
  type DraftStatus,
} from "./types"

function fail(op: string, error: { message?: string } | null): never {
  throw new Error(`ai_drafts ${op} failed: ${error?.message ?? "unknown error"}`)
}

export interface CreateDraftInput {
  userId: string
  context: DraftContext
  action: DraftAction
  params: unknown
  display: Record<string, unknown>
  amountGhs: number | null
  conversationKey: string | null
  expiresInMs: number
}

/** Validates params, supersedes older pending drafts in the same conversation, then inserts. */
export async function createDraft(db: SupabaseClient, input: CreateDraftInput): Promise<AiDraft> {
  const parsed = paramsSchemaFor(input.action).safeParse(input.params)
  if (!parsed.success) {
    throw new Error(`Invalid ${input.action} draft params: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`)
  }
  const now = Date.now()
  const nowIso = new Date(now).toISOString()

  if (input.conversationKey != null) {
    const { error } = await db
      .from("ai_drafts")
      .update({ status: "superseded", updated_at: nowIso })
      .eq("user_id", input.userId)
      .eq("conversation_key", input.conversationKey)
      .eq("status", "pending")
    if (error) fail("supersede", error)
  }

  const { data, error } = await db
    .from("ai_drafts")
    .insert({
      user_id: input.userId,
      context: input.context,
      action: input.action,
      params: parsed.data,
      display: input.display,
      amount_ghs: input.amountGhs,
      conversation_key: input.conversationKey,
      expires_at: new Date(now + input.expiresInMs).toISOString(),
    })
    .select()
    .single()
  if (error || !data) fail("insert", error)
  return data as AiDraft
}

export async function getOwnDraft(db: SupabaseClient, id: string, userId: string): Promise<AiDraft | null> {
  const { data, error } = await db.from("ai_drafts").select("*").eq("id", id).eq("user_id", userId).maybeSingle()
  if (error) fail("get", error)
  return (data as AiDraft | null) ?? null
}

/** Single atomic pending -> executing claim (owner, unexpired). Null means nothing was claimed. */
export async function claimDraft(db: SupabaseClient, id: string, userId: string): Promise<AiDraft | null> {
  const nowIso = new Date().toISOString()
  const { data, error } = await db
    .from("ai_drafts")
    .update({ status: "executing", updated_at: nowIso })
    .eq("id", id)
    .eq("user_id", userId)
    .eq("status", "pending")
    .gt("expires_at", nowIso)
    .select()
    .maybeSingle()
  if (error) fail("claim", error)
  return (data as AiDraft | null) ?? null
}

/**
 * Records the outcome. Only moves a row that is still in `from` (default `executing`, the claimed state), so a
 * finished draft can never be overwritten. Zero rows updated throws. `from: "unknown"` is used only by the recheck.
 */
export async function finishDraft(
  db: SupabaseClient,
  id: string,
  status: DraftStatus,
  outcome: Record<string, unknown>,
  from: DraftStatus = "executing",
): Promise<void> {
  const nowIso = new Date().toISOString()
  const patch: Record<string, unknown> = { status, outcome, updated_at: nowIso }
  if ((OUTCOME_STATUSES as readonly string[]).includes(status)) patch.executed_at = nowIso
  const { data, error } = await db.from("ai_drafts").update(patch).eq("id", id).eq("status", from).select("id")
  if (error) fail("finish", error)
  if (!data || (data as unknown[]).length === 0) fail("finish", { message: `draft is not in status ${from}` })
}

/** Marks a pending draft past its expiry as expired; returns the current row. */
export async function expireIfDue(db: SupabaseClient, draft: AiDraft): Promise<AiDraft> {
  if (draft.status !== "pending" || new Date(draft.expires_at).getTime() > Date.now()) return draft
  const nowIso = new Date().toISOString()
  const { data, error } = await db
    .from("ai_drafts")
    .update({ status: "expired", updated_at: nowIso })
    .eq("id", draft.id)
    .eq("status", "pending")
    .lte("expires_at", nowIso)
    .select()
    .maybeSingle()
  if (error) fail("expire", error)
  if (data) return data as AiDraft
  // Lost a race (claimed or cancelled meanwhile): return the real current state.
  return (await getOwnDraft(db, draft.id, draft.user_id)) ?? draft
}

/**
 * Progress write + heartbeat for a multi-id run: sets outcome and bumps updated_at, but only while the row is still
 * `executing`. False means 0 rows (the run was recovered or finished elsewhere): the caller must stop sending.
 */
export async function recordProgress(db: SupabaseClient, id: string, outcome: Record<string, unknown>): Promise<boolean> {
  const { data, error } = await db
    .from("ai_drafts")
    .update({ outcome, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "executing")
    .select("id")
  if (error) fail("progress", error)
  return !!data && (data as unknown[]).length > 0
}

/** An `executing` draft untouched for this long was interrupted (crash, killed function). */
export const STALE_EXECUTING_MS = 60_000

/**
 * Moves a stale `executing` draft to `unknown` ({code:'interrupted'}) so the recheck can resolve it. One conditional
 * update (still executing AND not touched for 60 s); zero rows means it finished meanwhile, so the fresh row is
 * returned. The original claim time is kept in outcome.claimed_at (updated_at is overwritten by this update); the
 * purchase settle window reads it because executed_at is never set on this path.
 */
export async function recoverStaleExecuting(db: SupabaseClient, draft: AiDraft): Promise<AiDraft> {
  if (draft.status !== "executing") return draft
  const now = Date.now()
  if (new Date(draft.updated_at).getTime() > now - STALE_EXECUTING_MS) return draft
  const { data, error } = await db
    .from("ai_drafts")
    .update({
      status: "unknown",
      // Keep any progress recorded by the run (sentIds, per-id results) so the recheck can build on it.
      outcome: { ...(draft.outcome ?? {}), code: "interrupted", message: "We couldn't confirm the result.", claimed_at: draft.updated_at },
      updated_at: new Date(now).toISOString(),
    })
    .eq("id", draft.id)
    .eq("status", "executing")
    .lt("updated_at", new Date(now - STALE_EXECUTING_MS).toISOString())
    .select()
    .maybeSingle()
  if (error) fail("recover", error)
  if (data) return data as AiDraft
  return (await getOwnDraft(db, draft.id, draft.user_id)) ?? draft
}

export async function cancelDraft(db: SupabaseClient, id: string, userId: string): Promise<AiDraft | null> {
  const { data, error } = await db
    .from("ai_drafts")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId)
    .eq("status", "pending")
    .select()
    .maybeSingle()
  if (error) fail("cancel", error)
  return (data as AiDraft | null) ?? null
}

/** Every terminal outcome the model must know about (not superseded): outcome statuses plus expired and cancelled. */
const TERMINAL_SINCE_STATUSES = [...OUTCOME_STATUSES, "expired", "cancelled"] as const

/** Drafts in this conversation that reached a terminal state (excl. superseded) with updated_at >= sinceIso, oldest first. */
export async function terminalDraftsSince(
  db: SupabaseClient,
  userId: string,
  conversationKey: string | null,
  sinceIso: string,
): Promise<AiDraft[]> {
  let q = db
    .from("ai_drafts")
    .select("*")
    .eq("user_id", userId)
    .in("status", [...TERMINAL_SINCE_STATUSES])
    .gte("updated_at", sinceIso)
  q = conversationKey == null ? q.is("conversation_key", null) : q.eq("conversation_key", conversationKey)
  const { data, error } = await q.order("updated_at", { ascending: true })
  if (error) fail("terminalSince", error)
  return (data as AiDraft[] | null) ?? []
}
