import type { SupabaseClient } from "@supabase/supabase-js"
import type { AiDraft } from "./types"
import { recordProgress } from "./repo"
import { resolveBulkStatusIds, type BulkStatusFilters, type BulkStatusIds } from "./bulk-status-ids"
import { walletOrderPrice } from "@/lib/pricing/wallet-order-price"
import { createStandingOrderTask } from "./standing-order"

// Runs a confirmed draft by calling the SAME endpoint the normal UI uses, with the caller's own JWT. This is the
// money path: every branch maps the endpoint's answer to exactly one terminal status, and anything ambiguous
// (timeout, thrown fetch, purchase 5xx) becomes `unknown` so the recheck can resolve it by reading state. Nothing
// here logs names, phones, emails or user ids.

export type ExecStatus = "succeeded" | "partial" | "failed" | "unknown"
export interface ExecResult {
  status: ExecStatus
  outcome: Record<string, unknown>
}

export interface ExecCall {
  baseUrl: string
  jwt: string
  /** Used to reconcile a BALANCE_CHANGED reply on a wallet adjustment. */
  db?: SupabaseClient
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Per-request timeout, default 15 s. */
  timeoutMs?: number
  /** Ids/orders dropped at revalidation; any skipped item makes a clean multi-id run `partial`. */
  skipped?: number
}

export const FETCH_TIMEOUT_MS = 15_000

/** A purchase with no order found is only declared not_placed once this long has passed since it was sent. */
export const PURCHASE_SETTLE_MS = 360_000

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
export const sameMoney = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.005

type WithdrawalAction = "approve" | "reject" | "complete"

// Statuses each withdrawal route accepts (mirrors prepare-admin.ts; kept local so this module stays light).
export const WITHDRAWAL_ELIGIBLE: Record<WithdrawalAction, readonly string[]> = {
  approve: ["pending", "failed"],
  reject: ["pending", "failed", "approved", "awaiting_transfer_otp"],
  complete: ["approved"],
}

/** Has this withdrawal reached the state the action is meant to produce? */
export function withdrawalApplied(action: WithdrawalAction, status: string): boolean {
  if (action === "reject") return status === "rejected"
  if (action === "complete") return status === "completed"
  return !["pending", "failed"].includes(status) // approve: approved, processing, completed, ...
}

export const BULK_TABLES = ["orders", "shop_orders", "ussd_orders", "ussd_shop_orders", "api_orders"] as const
export type BulkTable = (typeof BULK_TABLES)[number]
const BULK_COUNT_FIELD: Record<BulkTable, string> = {
  orders: "bulkCount",
  shop_orders: "shopCount",
  ussd_orders: "ussdCount",
  ussd_shop_orders: "ussdShopCount",
  api_orders: "apiCount",
}

type Posted = { reached: true; status: number; body: Record<string, any> } | { reached: false }

async function post(call: ExecCall, path: string, body: unknown): Promise<Posted> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), call.timeoutMs ?? FETCH_TIMEOUT_MS)
  try {
    const r = await (call.fetchImpl ?? fetch)(`${call.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${call.jwt}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    let json: any = null
    try {
      json = await r.json()
    } catch {
      json = null
    }
    return { reached: true, status: r.status, body: json && typeof json === "object" ? json : {} }
  } catch {
    return { reached: false }
  } finally {
    clearTimeout(timer)
  }
}

const errText = (body: Record<string, any>): string | undefined =>
  typeof body.error === "string" && body.error ? body.error.slice(0, 200) : undefined
const is2xx = (s: number) => s >= 200 && s < 300

const unknownResult = (extra: Record<string, unknown> = {}): ExecResult => ({
  status: "unknown",
  outcome: { code: "no_response", message: "We couldn't confirm the result.", ...extra },
})

/** Maps a non-success reply from an admin endpoint. */
function failedFrom(p: { status: number; body: Record<string, any> }): ExecResult {
  const message = errText(p.body)
  if (p.status >= 500) return { status: "failed", outcome: { code: "endpoint_error", ...(message ? { message } : {}) } }
  const code = typeof p.body.code === "string" && p.body.code ? p.body.code : "rejected"
  return { status: "failed", outcome: { code, ...(message ? { message } : {}) } }
}

// ---------------------------------------------------------------------------------------------------------------------
// Revalidation (spec 7.4 step 6)
// ---------------------------------------------------------------------------------------------------------------------

export type RevalidateResult =
  | { ok: true; draft: AiDraft; extra?: Record<string, unknown> }
  | { ok: false; status: "failed"; outcome: Record<string, unknown> }

const fail = (code: string, extra: Record<string, unknown> = {}): RevalidateResult => ({ ok: false, status: "failed", outcome: { code, ...extra } })

/**
 * Re-checks the draft against fresh data just before money moves. Returns the draft to execute (params possibly
 * narrowed or refreshed) or a failure that is recorded without calling any endpoint.
 */
export async function revalidateDraft(db: SupabaseClient, draft: AiDraft): Promise<RevalidateResult> {
  const p = draft.params as Record<string, any>

  if (draft.action === "wallet_order") {
    // packageId ONLY: the stored network/size are display values and never used for lookup.
    const { data: pkg, error: pkgErr } = await db
      .from("packages")
      .select("id, network, size, price, dealer_price, is_available")
      .eq("id", p.packageId)
      .maybeSingle()
    if (pkgErr) throw new Error("package read failed")
    if (!pkg || !(pkg as any).is_available) return fail("package_unavailable", { message: "This package is no longer available." })

    // Role comes from users.role, never from a session claim.
    const { data: userRow, error: userErr } = await db.from("users").select("role").eq("id", draft.user_id).maybeSingle()
    if (userErr) throw new Error("role read failed")
    const role = String((userRow as any)?.role || "user")

    let newPrice: number
    try {
      newPrice = round2(await walletOrderPrice(db, draft.user_id, role, pkg as any))
    } catch {
      return fail("prices_unavailable", { message: "Prices could not be loaded right now. Prepare the order again shortly." })
    }
    if (!Number.isFinite(newPrice) || newPrice <= 0) return fail("prices_unavailable", { message: "Prices could not be loaded right now." })
    if (!sameMoney(newPrice, Number(p.price))) return fail("price_changed", { oldPrice: Number(p.price), newPrice })

    // The purchase body's network is the package row's network, read fresh.
    return { ok: true, draft: { ...draft, params: { ...p, network: String((pkg as any).network) } } }
  }

  if (draft.action === "withdrawal_action") {
    const ids: string[] = Array.isArray(p.ids) ? p.ids : []
    const { data, error } = await db.from("withdrawal_requests").select("id, status").in("id", ids)
    if (error) throw new Error("withdrawal read failed")
    const status = new Map(((data ?? []) as { id: string; status: string }[]).map((w) => [w.id, w.status]))
    const eligible = WITHDRAWAL_ELIGIBLE[p.action as WithdrawalAction] ?? []
    const keep = ids.filter((id) => eligible.includes(status.get(id) ?? ""))
    if (keep.length === 0) return fail("all_changed", { message: "Every withdrawal on this card has changed since it was prepared.", skipped: ids.length })
    const extra = keep.length < ids.length ? { skipped: ids.length - keep.length } : undefined
    return { ok: true, draft: { ...draft, params: { ...p, ids: keep } }, extra }
  }

  if (draft.action === "bulk_status_update") {
    const fresh: BulkStatusIds = await resolveBulkStatusIds(db, (p.filter ?? {}) as BulkStatusFilters, p.status)
    const kept = {} as Record<BulkTable, string[]>
    let total = 0
    let skipped = 0
    for (const t of BULK_TABLES) {
      const still = new Set(fresh[t] ?? [])
      const mine: string[] = (p.idsByTable?.[t] ?? []) as string[]
      kept[t] = mine.filter((id) => still.has(id))
      total += kept[t].length
      skipped += mine.length - kept[t].length
    }
    if (total === 0) return fail("all_changed", { message: "Every order on this card has changed since it was prepared.", skipped })
    return { ok: true, draft: { ...draft, params: { ...p, idsByTable: kept } }, extra: skipped > 0 ? { skipped } : undefined }
  }

  // wallet_adjustment: the endpoint's expectedBalance is the guard. user_suspension / role_change are set-to-value.
  return { ok: true, draft }
}

// ---------------------------------------------------------------------------------------------------------------------
// Execution (spec 7.4 steps 7-8)
// ---------------------------------------------------------------------------------------------------------------------

export async function executeDraft(draft: AiDraft, call: ExecCall): Promise<ExecResult> {
  const p = draft.params as Record<string, any>
  switch (draft.action) {
    case "wallet_order":
      return executeWalletOrder(draft, p, call)
    case "wallet_adjustment":
      return executeWalletAdjustment(p, call)
    case "withdrawal_action":
      return executeWithdrawals(draft, p, call)
    case "user_suspension": {
      const r = await post(call, "/api/admin/users/suspend", { userId: p.targetUserId, action: p.suspend ? "suspend" : "unsuspend" })
      if (!r.reached) return unknownResult()
      return is2xx(r.status) ? { status: "succeeded", outcome: {} } : failedFrom(r)
    }
    case "role_change": {
      const r = await post(call, "/api/admin/users/update-role", { userId: p.targetUserId, role: p.toRole })
      if (!r.reached) return unknownResult()
      return is2xx(r.status) ? { status: "succeeded", outcome: {} } : failedFrom(r)
    }
    case "bulk_status_update":
      return executeBulk(draft, p, call)
    default:
      return { status: "failed", outcome: { code: "unsupported_action" } }
  }
}

async function executeWalletOrder(draft: AiDraft, p: Record<string, any>, call: ExecCall): Promise<ExecResult> {
  // A scheduled order is a standing order: confirming creates the task row and places NO order. This runs after
  // revalidateDraft re-quoted the price, so the cap stored on the task is the freshly confirmed price. The cron then
  // runs it without the model (see standing-order.ts). Needs the service-role client: the standing-order columns are
  // refused for client roles by the 0188 guard trigger.
  if (p.schedule) {
    if (!call.db) return { status: "failed", outcome: { code: "schedule_unavailable", message: "This order could not be scheduled." } }
    let made
    try {
      made = await createStandingOrderTask(call.db, draft)
    } catch {
      made = { ok: false as const }
    }
    if (!made.ok) return { status: "failed", outcome: { code: "schedule_failed", message: "This order could not be scheduled." } }
    return { status: "succeeded", outcome: { code: "scheduled", task_id: made.taskId, next_run_at: made.nextRunAt } }
  }

  const r = await post(call, "/api/orders/purchase", {
    packageId: p.packageId,
    phoneNumber: p.recipient,
    network: p.network,
    idempotencyKey: draft.id,
  })
  if (!r.reached) return unknownResult()

  const message = errText(r.body)
  if (is2xx(r.status)) {
    const order = r.body.order as Record<string, any> | undefined
    return {
      status: "succeeded",
      outcome: {
        ...(order?.order_code ? { order_code: order.order_code } : {}),
        ...(typeof r.body.newBalance === "number" ? { new_balance: r.body.newBalance } : {}),
        ...(r.body.alreadyPlaced === true ? { alreadyPlaced: true } : {}),
      },
    }
  }
  if (r.status === 402) return { status: "failed", outcome: { code: "insufficient_balance", ...(message ? { message } : {}) } }
  // 5xx is ambiguous on a purchase (debit and order insert may have happened): the recheck resolves it by key.
  if (r.status >= 500) return unknownResult({ httpStatus: r.status })
  // A concurrent duplicate that slipped past the claim: the other request placed it. Recheck finds the order.
  if (r.status === 409 && message === "Duplicate request") return unknownResult({ httpStatus: 409 })
  const code = typeof r.body.code === "string" && r.body.code ? r.body.code : "rejected"
  return { status: "failed", outcome: { code, ...(message ? { message } : {}) } }
}

async function executeWalletAdjustment(p: Record<string, any>, call: ExecCall): Promise<ExecResult> {
  const r = await post(call, "/api/admin/update-balance", {
    userId: p.targetUserId,
    type: p.type,
    amount: p.amount,
    reason: p.reason,
    expectedBalance: p.balanceBefore,
  })
  if (!r.reached) return unknownResult()
  if (is2xx(r.status)) {
    const bal = r.body.balance ?? r.body.data?.balance
    return { status: "succeeded", outcome: typeof bal === "number" ? { new_balance: bal } : {} }
  }
  const message = errText(r.body)
  if (r.status === 409 && /balance changed/i.test(message ?? "")) {
    // BALANCE_CHANGED: either this adjustment already applied (a replay) or someone else moved the wallet.
    if (call.db) {
      try {
        const { data } = await call.db.from("wallets").select("balance").eq("user_id", p.targetUserId).maybeSingle()
        const bal = Number((data as any)?.balance)
        const after = round2(Number(p.balanceBefore) + (p.type === "credit" ? Number(p.amount) : -Number(p.amount)))
        if (sameMoney(bal, after)) return { status: "succeeded", outcome: { alreadyApplied: true, new_balance: bal } }
      } catch {
        // fall through to balance_changed
      }
    }
    return { status: "failed", outcome: { code: "balance_changed", ...(message ? { message } : {}) } }
  }
  return failedFrom(r)
}

interface PerId {
  id: string
  ok: boolean
  error?: string
  unknown?: boolean
}

function tally(results: Array<{ ok: boolean; unknown?: boolean }>): ExecStatus {
  if (results.some((r) => r.unknown)) return "unknown"
  const okCount = results.filter((r) => r.ok).length
  if (okCount === results.length) return "succeeded"
  return okCount > 0 ? "partial" : "failed"
}

/**
 * Progress write that doubles as the heartbeat (bumps updated_at). False means the row is no longer `executing`
 * (recovered or stolen) or the write failed: the run must stop sending.
 */
async function progress(call: ExecCall, draftId: string, outcome: Record<string, unknown>): Promise<boolean> {
  if (!call.db) return true
  try {
    return await recordProgress(call.db, draftId, outcome)
  } catch {
    return false
  }
}

/** The run lost its claim: stop, report what was done so far as unknown. The recheck resolves the rest. */
function lostClaim(outcome: Record<string, unknown>): ExecResult {
  console.error("ai_drafts: progress write lost, run stopped")
  return { status: "unknown", outcome: { ...outcome, code: "interrupted", message: "We couldn't confirm the result." } }
}

/** Skipped ids (no longer eligible at confirm) make an otherwise clean run partial (R14). */
const settle = (status: ExecStatus, skipped: number): ExecStatus => (status === "succeeded" && skipped > 0 ? "partial" : status)

async function executeWithdrawals(draft: AiDraft, p: Record<string, any>, call: ExecCall): Promise<ExecResult> {
  const action = p.action as WithdrawalAction
  const ids = p.ids as string[]
  const skipped = call.skipped ?? 0
  const base = { sentIds: ids, ...(skipped > 0 ? { skipped } : {}) }
  const results: PerId[] = []
  const snapshot = () => ({ ...base, results: [...results], applied: results.filter((x) => x.ok).length, total: ids.length })

  // Persist the narrowed list before the first call so a lost finish can be rechecked against exactly what was sent.
  if (!(await progress(call, draft.id, { ...base, results: [] }))) return lostClaim(snapshot())
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]
    const body: Record<string, unknown> = { withdrawalId: id }
    if (action === "reject" && p.reason) body.reason = p.reason
    const r = await post(call, `/api/admin/withdrawals/${action}`, body)
    if (!r.reached) results.push({ id, ok: false, error: "no_response", unknown: true })
    else if (is2xx(r.status)) results.push({ id, ok: true })
    else results.push({ id, ok: false, error: errText(r.body) ?? `http_${r.status}` })
    if (i < ids.length - 1 && !(await progress(call, draft.id, snapshot()))) return lostClaim(snapshot())
  }
  return { status: settle(tally(results), skipped), outcome: snapshot() }
}

async function executeBulk(draft: AiDraft, p: Record<string, any>, call: ExecCall): Promise<ExecResult> {
  const results: Array<{ table: string; count: number; ok: boolean; error?: string; unknown?: boolean }> = []
  const sentIds: Record<string, string[]> = {}
  for (const table of BULK_TABLES) {
    const ids: string[] = (p.idsByTable?.[table] ?? []) as string[]
    if (ids.length > 0) sentIds[table] = ids
  }
  const tables = Object.keys(sentIds) as BulkTable[]
  const skipped = call.skipped ?? 0
  const base = { sentIds, ...(skipped > 0 ? { skipped } : {}) }
  let applied = 0
  const snapshot = () => ({ ...base, results: [...results], applied })

  if (!(await progress(call, draft.id, { ...base, results: [] }))) return lostClaim(snapshot())
  for (let i = 0; i < tables.length; i++) {
    const table = tables[i]
    const ids = sentIds[table]
    const r = await post(call, "/api/admin/orders/bulk-update-status", { orderIds: ids, status: p.status, orderType: table })
    if (!r.reached) {
      results.push({ table, count: ids.length, ok: false, error: "no_response", unknown: true })
    } else if (is2xx(r.status)) {
      const reported = r.body[BULK_COUNT_FIELD[table]]
      const count = typeof reported === "number" ? reported : ids.length
      applied += count
      results.push({ table, count, ok: true })
    } else {
      results.push({ table, count: ids.length, ok: false, error: errText(r.body) ?? `http_${r.status}` })
    }
    if (i < tables.length - 1 && !(await progress(call, draft.id, snapshot()))) return lostClaim(snapshot())
  }
  return { status: settle(tally(results), skipped), outcome: snapshot() }
}
