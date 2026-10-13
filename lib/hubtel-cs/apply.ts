import type { HubtelCsStore, UpdateGuard } from "./store"
import type { Transition } from "./state-machine"
import type { HubtelCsTx } from "./types"

/**
 * Commit a state-machine transition with a state guard, then fire the order hook when the row
 * ENTERS fulfilled/failed/needs_review. If another writer moved the row first (guard fails) nothing is
 * written and the current row is returned. `onTransition` must not throw (see adapters.notifyAdapter).
 */
export async function applyAndCommit(
  store: HubtelCsStore,
  tx: HubtelCsTx,
  transition: Transition,
  onTransition: (tx: HubtelCsTx) => Promise<void>,
  guard?: UpdateGuard
): Promise<{ tx: HubtelCsTx; changed: boolean }> {
  if ("ignored" in transition) return { tx, changed: false }
  const updated = await store.updateGuarded(tx.id, tx.state, transition.patch, guard)
  if (!updated) return { tx: (await store.getByRef(tx.client_reference)) ?? tx, changed: false }
  const entered = updated.state !== tx.state &&
    (updated.state === "fulfilled" || updated.state === "failed" || updated.state === "needs_review")
  if (entered) await onTransition(updated)
  return { tx: updated, changed: true }
}
