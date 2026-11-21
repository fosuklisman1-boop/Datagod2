import type { SupabaseClient } from "@supabase/supabase-js"
import { claimDraft, expireIfDue, finishDraft, getOwnDraft, recoverStaleExecuting } from "./repo"
import type { AiDraft, DraftStatus } from "./types"
import {
  BULK_TABLES,
  PURCHASE_SETTLE_MS,
  executeDraft,
  revalidateDraft,
  round2,
  sameMoney,
  withdrawalApplied,
  type ExecResult,
  type ExecStatus,
} from "./execute"

// Confirm / recheck logic behind POST /api/ai/drafts/[id]/confirm (spec 7.4). The route stays thin. The draft is
// claimed exactly once (atomic pending -> executing), re-validated against fresh data, then the existing endpoint
// runs with the caller's own JWT. Logs carry no names, phones, emails or user ids.

/** What the card shows. `already_done` is a replay of a used draft; `finalStatus` then says succeeded or partial. */
export interface CardState {
  status: DraftStatus | "already_done"
  outcome: Record<string, unknown> | null
  display: unknown
  finalStatus?: DraftStatus
}

export interface ConfirmCaller {
  userId: string
  isAdmin: boolean
  jwt: string
  baseUrl: string
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const ADMIN_ACTIONS = new Set<string>(["wallet_adjustment", "withdrawal_action", "user_suspension", "role_change", "bulk_status_update"])

/** The state to show for a stored draft row. A used succeeded/partial draft reads as already_done. */
function toCardState(d: AiDraft): CardState {
  if (d.status === "succeeded" || d.status === "partial") {
    return { status: "already_done", finalStatus: d.status, outcome: d.outcome, display: d.display }
  }
  return { status: d.status, outcome: d.outcome, display: d.display }
}

/** The state just produced by this call (the first tap shows the real status, except a reconciled replay). */
function resultState(d: AiDraft, status: ExecStatus, outcome: Record<string, unknown>): CardState {
  const replay = status === "succeeded" && (outcome.alreadyPlaced === true || outcome.alreadyApplied === true)
  return replay
    ? { status: "already_done", finalStatus: "succeeded", outcome, display: d.display }
    : { status, outcome, display: d.display }
}

const adminRequired = (d: AiDraft): CardState => ({ status: "failed", outcome: { code: "admin_required" }, display: d.display })

export async function confirmDraft(db: SupabaseClient, id: string, caller: ConfirmCaller): Promise<CardState | null> {
  // 2. Own draft only (anything else reads as not found).
  const loaded = await getOwnDraft(db, id, caller.userId)
  if (!loaded) return null
  const found = await recoverStaleExecuting(db, loaded)

  // 3. Already finished (or executing elsewhere): return the stored state, never run again.
  if (found.status !== "pending") return toCardState(found)

  // 4. Past its expiry: record it and stop.
  const draft = await expireIfDue(db, found)
  if (draft.status !== "pending") return toCardState(draft)

  // Admin actions need an admin caller. Refused before the claim, so the draft stays pending.
  if (ADMIN_ACTIONS.has(draft.action) && !caller.isAdmin) return adminRequired(draft)

  // 5. Atomic claim. Zero rows: someone else claimed, cancelled or expired it. Report what it is now.
  const claimed = await claimDraft(db, id, caller.userId)
  if (!claimed) {
    const now = await getOwnDraft(db, id, caller.userId)
    return now ? toCardState(now) : null
  }

  // 6. Fresh re-validation. A failure is recorded and no endpoint is called.
  let rev
  try {
    rev = await revalidateDraft(db, claimed)
  } catch {
    const outcome = { code: "revalidate_error", message: "Something went wrong checking this action. Prepare it again." }
    await safeFinish(db, id, "failed", outcome)
    return { status: "failed", outcome, display: claimed.display }
  }
  if (!rev.ok) {
    await safeFinish(db, id, "failed", rev.outcome)
    return { status: "failed", outcome: rev.outcome, display: claimed.display }
  }

  // 7. Call the existing endpoint with the caller's own JWT.
  let result: ExecResult
  try {
    result = await executeDraft(rev.draft, {
      baseUrl: caller.baseUrl,
      jwt: caller.jwt,
      db,
      fetchImpl: caller.fetchImpl,
      timeoutMs: caller.timeoutMs,
    })
  } catch {
    result = { status: "unknown", outcome: { code: "no_response", message: "We couldn't confirm the result." } }
  }

  // 8. Store the outcome.
  const outcome = { ...(rev.extra ?? {}), ...result.outcome }
  await safeFinish(db, id, result.status, outcome)
  return resultState(claimed, result.status, outcome)
}

/** Finish a claimed draft. The endpoint already ran (or was refused), so a write failure must not hide the result. */
async function safeFinish(db: SupabaseClient, id: string, status: DraftStatus, outcome: Record<string, unknown>, from?: DraftStatus) {
  try {
    await finishDraft(db, id, status, outcome, from)
  } catch {
    console.error("ai_drafts: could not record outcome", { status })
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Recheck (spec 7.4 step 9): only for `unknown`, read-only against the world, safe to repeat.
// ---------------------------------------------------------------------------------------------------------------------

const CHUNK = 200
async function inChunks<T>(ids: string[], read: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await read(ids.slice(i, i + CHUNK))
    if (error) throw new Error("recheck read failed")
    out.push(...(data ?? []))
  }
  return out
}

function countStatus(applied: number, total: number): ExecStatus {
  if (total > 0 && applied === total) return "succeeded"
  return applied > 0 ? "partial" : "failed"
}

async function recheckResult(db: SupabaseClient, draft: AiDraft): Promise<ExecResult> {
  const p = draft.params as Record<string, any>

  switch (draft.action) {
    case "wallet_order": {
      const { data, error } = await db
        .from("orders")
        .select("id, order_code")
        .eq("idempotency_key", draft.id)
        .eq("user_id", draft.user_id)
        .maybeSingle()
      if (error) throw new Error("recheck read failed")
      if (data) return { status: "succeeded", outcome: { order_code: (data as any).order_code, rechecked: true } }
      // The request may still be in flight server-side. Only conclude after the settle window, measured from when
      // it was sent: executed_at, else the original claim time kept by recoverStaleExecuting, else updated_at.
      const claimedAt = (draft.outcome as any)?.claimed_at
      const sentAt = Date.parse(draft.executed_at ?? (typeof claimedAt === "string" ? claimedAt : draft.updated_at))
      if (!Number.isFinite(sentAt) || Date.now() - sentAt < PURCHASE_SETTLE_MS) {
        return { status: "unknown", outcome: { code: "still_checking", message: "Still checking. Try again in a few minutes." } }
      }
      return { status: "failed", outcome: { code: "not_placed", message: "The order was not placed and you were not charged. Prepare it again." } }
    }

    case "wallet_adjustment": {
      const { data, error } = await db.from("wallets").select("balance").eq("user_id", p.targetUserId).maybeSingle()
      if (error || !data) throw new Error("recheck read failed")
      const bal = Number((data as any).balance)
      const before = Number(p.balanceBefore)
      const after = round2(before + (p.type === "credit" ? Number(p.amount) : -Number(p.amount)))
      if (sameMoney(bal, after)) return { status: "succeeded", outcome: { new_balance: bal, rechecked: true } }
      if (sameMoney(bal, before)) {
        return { status: "failed", outcome: { code: "not_applied", message: "The adjustment was not applied. It is safe to prepare it again." } }
      }
      return { status: "unknown", outcome: { code: "check_wallet_history", message: "Check the user's wallet history." } }
    }

    case "user_suspension": {
      const { data, error } = await db.from("users").select("is_suspended").eq("id", p.targetUserId).maybeSingle()
      if (error || !data) throw new Error("recheck read failed")
      return !!(data as any).is_suspended === !!p.suspend
        ? { status: "succeeded", outcome: { rechecked: true } }
        : { status: "failed", outcome: { code: "not_applied" } }
    }

    case "role_change": {
      const { data, error } = await db.from("users").select("role").eq("id", p.targetUserId).maybeSingle()
      if (error || !data) throw new Error("recheck read failed")
      return (data as any).role === p.toRole
        ? { status: "succeeded", outcome: { rechecked: true } }
        : { status: "failed", outcome: { code: "not_applied" } }
    }

    case "withdrawal_action": {
      const stored = (draft.outcome?.results as Array<{ id: string }> | undefined)?.map((r) => r.id)
      const ids = stored && stored.length > 0 ? stored : (p.ids as string[])
      const rows = await inChunks<{ id: string; status: string }>(ids, (c) =>
        db.from("withdrawal_requests").select("id, status").in("id", c),
      )
      const status = new Map(rows.map((r) => [r.id, r.status]))
      const results = ids.map((id) => {
        const ok = withdrawalApplied(p.action, status.get(id) ?? "")
        return ok ? { id, ok } : { id, ok, error: "not_applied" }
      })
      const applied = results.filter((r) => r.ok).length
      return { status: countStatus(applied, results.length), outcome: { results, applied, total: results.length, rechecked: true } }
    }

    case "bulk_status_update": {
      const sent = (draft.outcome?.sentIds as Record<string, string[]> | undefined) ?? (p.idsByTable as Record<string, string[]>)
      let applied = 0
      let total = 0
      const results: Array<{ table: string; count: number; total: number }> = []
      for (const table of BULK_TABLES) {
        const ids = sent?.[table] ?? []
        if (ids.length === 0) continue
        const col = table === "orders" || table === "api_orders" ? "status" : "order_status"
        const rows = await inChunks<Record<string, string>>(ids, (c) => db.from(table).select(`id, ${col}`).in("id", c))
        const hit = rows.filter((r) => r[col] === p.status).length
        applied += hit
        total += ids.length
        results.push({ table, count: hit, total: ids.length })
      }
      return { status: countStatus(applied, total), outcome: { results, applied, total, rechecked: true } }
    }

    default:
      return { status: "unknown", outcome: { code: "check_manually" } }
  }
}

export async function recheckDraft(db: SupabaseClient, id: string, caller: ConfirmCaller): Promise<CardState | null> {
  const loaded = await getOwnDraft(db, id, caller.userId)
  if (!loaded) return null
  const draft = await recoverStaleExecuting(db, loaded)
  if (draft.status !== "unknown") return toCardState(draft)
  if (ADMIN_ACTIONS.has(draft.action) && !caller.isAdmin) return adminRequired(draft)

  let result: ExecResult
  try {
    result = await recheckResult(db, draft)
  } catch {
    // Could not read the state: stay unknown, unchanged.
    return { status: "unknown", outcome: { ...(draft.outcome ?? {}), code: "recheck_failed" }, display: draft.display }
  }

  // Still-checking is not written: rewriting would restart the settle clock (executed_at) and lose claimed_at.
  if (result.status === "unknown" && result.outcome.code === "still_checking") {
    return { status: "unknown", outcome: result.outcome, display: draft.display }
  }

  try {
    await finishDraft(db, id, result.status, result.outcome, "unknown")
  } catch {
    // A concurrent recheck already settled it: report the row as it is now.
    const now = await getOwnDraft(db, id, caller.userId)
    if (now) return toCardState(now)
  }
  return resultState(draft, result.status, result.outcome)
}
