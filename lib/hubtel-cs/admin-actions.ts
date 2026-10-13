import { getOrderAdapter } from "./adapters"
import { applyAndCommit } from "./apply"
import { applyResolve, applyStatusCheck, RECHECK_GAP_MS } from "./state-machine"
import type { HubtelCsStore } from "./store"
import type { HubtelCsTx } from "./types"

export interface AdminDeps {
  store: HubtelCsStore
  checkStatus(ref: string): Promise<{ ok: boolean; status?: string; data?: any; error?: string }>
  onTransition(tx: HubtelCsTx): Promise<void>
  now?: () => Date
}
type Out = { ok: boolean; message: string; tx: HubtelCsTx | null; provenance?: { resolved_by: string | null; resolution_note: string | null } }

export async function adminCheckStatus(deps: AdminDeps, ref: string): Promise<Out> {
  const tx = await deps.store.getByRef(ref)
  if (!tx) return { ok: false, message: "Unknown reference", tx: null }
  let res: Awaited<ReturnType<AdminDeps["checkStatus"]>>
  try {
    res = await deps.checkStatus(ref)
  } catch (e: any) {
    const error = e?.message ?? String(e)
    await deps.store.logEvent({ client_reference: ref, direction: "status_check", ok: false, payload: null, error }).catch(() => {})
    return { ok: false, message: `Status check failed: ${error}`, tx }
  }
  const data = res.data ?? {}
  await deps.store.logEvent({ client_reference: ref, direction: "status_check", ok: res.ok, payload: res.data ?? null, error: res.error ?? null })
  const now = (deps.now ?? (() => new Date()))()
  // Same rule as the cron: a check made inside the recheck gap is recorded but never counts as a second negative.
  const withinGap = !!tx.last_status_check_at && now.getTime() - Date.parse(tx.last_status_check_at) < RECHECK_GAP_MS
  const transition = applyStatusCheck(tx, { ok: res.ok, status: res.status ?? data.status, isFulfilled: data.isFulfilled }, now, { countNegative: !withinGap })
  const out = await applyAndCommit(deps.store, tx, transition, deps.onTransition)
  if (!res.ok) return { ok: false, message: `Status check failed: ${res.error ?? "unknown error"}`, tx: out.tx }
  const gapNote = withinGap && data.isFulfilled === false ? " Checked again within 90s of the previous check, so this negative was not counted." : ""
  return { ok: true, message: `Hubtel says: ${res.status ?? data.status ?? "unknown"} (fulfilled: ${String(data.isFulfilled ?? "unknown")}). Row is ${out.tx.state}.${gapNote}`, tx: out.tx }
}

export async function adminResolve(deps: AdminDeps, ref: string, outcome: "fulfilled" | "failed", note: string, adminId: string): Promise<Out> {
  if (!note || !note.trim()) return { ok: false, message: "A note is required", tx: null }
  const tx = await deps.store.getByRef(ref)
  if (!tx) return { ok: false, message: "Unknown reference", tx: null }
  if (outcome === "fulfilled" && tx.refund_claimed_at) return { ok: false, message: "A refund has been issued or claimed for this order; it cannot be marked fulfilled", tx }
  const transition = applyResolve(tx, outcome, note.trim(), adminId, (deps.now ?? (() => new Date()))())
  if ("ignored" in transition) return { ok: false, message: transition.ignored, tx }
  let out: Awaited<ReturnType<typeof applyAndCommit>>
  try {
    // Resolving to fulfilled must lose to a refund claim that lands between our read and this write.
    out = await applyAndCommit(deps.store, tx, transition, deps.onTransition, outcome === "fulfilled" ? { refundUnclaimed: true } : undefined)
  } catch (e: any) {
    const dup = e?.code === "23505" || (/duplicate key value violates unique constraint/i.test(String(e?.message ?? "")) && /order_active/.test(String(e?.message ?? "")))
    if (dup) return { ok: false, message: "Another active purchase exists for this order; cannot mark this one fulfilled", tx }
    throw e
  }
  return out.changed ? { ok: true, message: `Marked ${outcome}`, tx: out.tx } : { ok: false, message: "The row changed while resolving; reload and retry", tx: out.tx }
}

/**
 * Manual refund only. Never invoked automatically. The ledger row is atomically claimed BEFORE the
 * adapter runs, so concurrent/repeat calls cannot double-refund. A thrown adapter error keeps the claim.
 */
export async function adminRefund(deps: AdminDeps, ref: string, adminId: string, opts: { force?: boolean } = {}): Promise<Out> {
  const tx = await deps.store.getByRef(ref)
  if (!tx) return { ok: false, message: "Unknown reference", tx: null }
  const provenance = { resolved_by: tx.resolved_by, resolution_note: tx.resolution_note }
  if (tx.state !== "failed") return { ok: false, message: "Only failed transactions can be refunded", tx, provenance }
  const adapter = getOrderAdapter(tx.order_table)
  if (!adapter?.refundToWallet || !tx.order_id) return { ok: false, message: "No refund handler is registered for this order type", tx, provenance }
  if (tx.resolved_by && !opts.force) {
    return { ok: false, message: `This row was marked failed by an admin override (${tx.resolved_by}: ${tx.resolution_note ?? "no note"}), not by Hubtel. Pass force to refund anyway.`, tx, provenance }
  }
  const claimed = await deps.store.claimRefund(tx.id, adminId)
  if (!claimed) return { ok: false, message: "Refund already claimed or row not failed", tx: (await deps.store.getByRef(ref)) ?? tx, provenance }
  try {
    const r = await adapter.refundToWallet(claimed, adminId)
    if (!r.refunded) {
      await deps.store.releaseRefundClaim(tx.id)
      return { ok: false, message: r.message, tx: (await deps.store.getByRef(ref)) ?? tx, provenance }
    }
    return { ok: true, message: r.message, tx: (await deps.store.getByRef(ref)) ?? claimed, provenance }
  } catch (e: any) {
    return { ok: false, message: `Refund outcome UNKNOWN (${e?.message ?? e}). The claim was kept; check the wallet before any retry.`, tx: (await deps.store.getByRef(ref)) ?? claimed, provenance }
  }
}
