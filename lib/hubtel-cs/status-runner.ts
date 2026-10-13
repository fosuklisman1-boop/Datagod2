import { applyAndCommit } from "./apply"
import { applyStatusCheck, sweepStale, CREATED_STALE_MS, RECHECK_GAP_MS } from "./state-machine"
import type { HubtelCsStore } from "./store"
import type { HubtelCsTx } from "./types"

export interface RunDeps {
  store: HubtelCsStore
  check(ref: string): Promise<{ ok: boolean; status?: string; data?: any; error?: string }>
  onTransition(tx: HubtelCsTx): Promise<void>
  now?: () => Date
  deadlineMs: number
  batch?: number
}

/** Hubtel makes the status check mandatory for pending rows older than 5 minutes. */
const MIN_PENDING_AGE_MS = 5 * 60_000

/** PostgREST PGRST205 / Postgres 42P01: the ledger table does not exist yet (migrations 0113/0114 not applied). */
export function isMissingTableError(e: unknown): boolean {
  const code = (e as any)?.code
  return code === "PGRST205" || code === "42P01"
}
let warnedNotMigrated = false
/** Warn at most once per process so the every-2-minutes cron does not spam logs before migration. */
export function warnLedgerNotMigrated(): void {
  if (warnedNotMigrated) return
  warnedNotMigrated = true
  console.warn("[hubtel-cs] ledger table missing (migrations 0113/0114 not applied); skipping reconciliation")
}

/** Reconciliation only: never POSTs a purchase, never reads the pause/enabled flags, never resends or refunds. */
export async function runHubtelCsStatusChecks(deps: RunDeps) {
  const now = deps.now ?? (() => new Date())
  const out: { swept: number; checked: number; fulfilled: number; failed: number; needsReview: number; errors: number; skipped?: string } =
    { swept: 0, checked: 0, fulfilled: 0, failed: 0, needsReview: 0, errors: 0 }
  // A hook failure must never break reconciliation of the rest.
  const safeHook = async (tx: HubtelCsTx) => {
    try { await deps.onTransition(tx) } catch (e: any) { console.error("[hubtel-cs] onTransition hook failed:", e?.message ?? e) }
  }

  // 1. rows whose request never completed (process died between insert and the Hubtel reply)
  try {
    const stale = await deps.store.listByStates(["created"], { olderThan: new Date(now().getTime() - CREATED_STALE_MS).toISOString(), limit: 100 })
    for (const tx of stale) {
      try {
        const r = await applyAndCommit(deps.store, tx, sweepStale(tx, now()), safeHook)
        if (r.changed) out.swept++
      } catch (e: any) { out.errors++; console.error("[hubtel-cs] sweep row failed:", e?.message ?? e) }
    }
  } catch (e: any) {
    if (isMissingTableError(e)) { out.skipped = "ledger not migrated"; warnLedgerNotMigrated() }
    else { out.errors++; console.error("[hubtel-cs] sweep phase failed:", e?.message ?? e) }
  }

  // 2. pending rows older than 5 minutes, least-recently-checked first
  let pending: HubtelCsTx[] = []
  try {
    pending = await deps.store.listByStates(["pending"], {
      olderThan: new Date(now().getTime() - MIN_PENDING_AGE_MS).toISOString(),
      limit: deps.batch ?? 50, orderBy: "last_status_check_at",
    })
  } catch (e: any) {
    if (isMissingTableError(e)) { out.skipped = "ledger not migrated"; warnLedgerNotMigrated() }
    else { out.errors++; console.error("[hubtel-cs] pending list failed:", e?.message ?? e) }
  }
  for (const tx of pending) {
    if (Date.now() >= deps.deadlineMs) break
    if (tx.last_status_check_at && now().getTime() - Date.parse(tx.last_status_check_at) < RECHECK_GAP_MS) continue
    try {
      let res: Awaited<ReturnType<typeof deps.check>>
      try { res = await deps.check(tx.client_reference) } catch (e: any) { res = { ok: false, error: e?.message ?? "status check threw" } }
      out.checked++
      if (!res.ok) out.errors++
      // Logging is best-effort: it must not discard the check result or block the transition.
      try {
        await deps.store.logEvent({ client_reference: tx.client_reference, direction: "status_check", ok: res.ok, payload: res.data ?? null, error: res.error ?? null })
      } catch (e: any) { console.warn("[hubtel-cs] status_check event log failed:", e?.message ?? e) }
      const data = res.data ?? {}
      const transition = applyStatusCheck(tx, { ok: res.ok, status: res.status ?? data.status, isFulfilled: data.isFulfilled }, now())
      const r = await applyAndCommit(deps.store, tx, transition, safeHook)
      if (r.changed && r.tx.state !== tx.state) {
        if (r.tx.state === "fulfilled") out.fulfilled++
        else if (r.tx.state === "failed") out.failed++
        else if (r.tx.state === "needs_review") out.needsReview++
      }
    } catch (e: any) { out.errors++; console.error("[hubtel-cs] row failed:", e?.message ?? e) }
  }
  return out
}
