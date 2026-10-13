import { getOrderAdapter } from "./adapters"
import { applyAndCommit } from "./apply"
import { applyResolve, applyStatusCheck } from "./state-machine"
import type { HubtelCsStore } from "./store"
import type { HubtelCsTx } from "./types"

export interface AdminDeps {
  store: HubtelCsStore
  checkStatus(ref: string): Promise<{ ok: boolean; status?: string; data?: any; error?: string }>
  onTransition(tx: HubtelCsTx): Promise<void>
  now?: () => Date
}
type Out = { ok: boolean; message: string; tx: HubtelCsTx | null }

export async function adminCheckStatus(deps: AdminDeps, ref: string): Promise<Out> {
  const tx = await deps.store.getByRef(ref)
  if (!tx) return { ok: false, message: "Unknown reference", tx: null }
  const res = await deps.checkStatus(ref)
  const data = res.data ?? {}
  await deps.store.logEvent({ client_reference: ref, direction: "status_check", ok: res.ok, payload: res.data ?? null, error: res.error ?? null })
  const transition = applyStatusCheck(tx, { ok: res.ok, status: res.status ?? data.status, isFulfilled: data.isFulfilled }, (deps.now ?? (() => new Date()))())
  const out = await applyAndCommit(deps.store, tx, transition, deps.onTransition)
  if (!res.ok) return { ok: false, message: `Status check failed: ${res.error ?? "unknown error"}`, tx: out.tx }
  return { ok: true, message: `Hubtel says: ${res.status ?? data.status ?? "unknown"} (fulfilled: ${String(data.isFulfilled ?? "unknown")}). Row is ${out.tx.state}.`, tx: out.tx }
}

export async function adminResolve(deps: AdminDeps, ref: string, outcome: "fulfilled" | "failed", note: string, adminId: string): Promise<Out> {
  if (!note || !note.trim()) return { ok: false, message: "A note is required", tx: null }
  const tx = await deps.store.getByRef(ref)
  if (!tx) return { ok: false, message: "Unknown reference", tx: null }
  const transition = applyResolve(tx, outcome, note.trim(), adminId, (deps.now ?? (() => new Date()))())
  if ("ignored" in transition) return { ok: false, message: transition.ignored, tx }
  const out = await applyAndCommit(deps.store, tx, transition, deps.onTransition)
  return out.changed ? { ok: true, message: `Marked ${outcome}`, tx: out.tx } : { ok: false, message: "The row changed while resolving; reload and retry", tx: out.tx }
}

/** Manual refund only. Never invoked automatically; delegates to the registered OrderAdapter. */
export async function adminRefund(deps: AdminDeps, ref: string, adminId: string): Promise<Out> {
  const tx = await deps.store.getByRef(ref)
  if (!tx) return { ok: false, message: "Unknown reference", tx: null }
  if (tx.state !== "failed") return { ok: false, message: "Only failed transactions can be refunded", tx }
  const adapter = getOrderAdapter(tx.order_table)
  if (!adapter?.refundToWallet || !tx.order_id) return { ok: false, message: "No refund handler is registered for this order type", tx }
  try {
    const r = await adapter.refundToWallet(tx, adminId)
    return { ok: r.refunded, message: r.message, tx }
  } catch (e: any) {
    return { ok: false, message: `Refund failed: ${e?.message ?? e}`, tx }
  }
}
