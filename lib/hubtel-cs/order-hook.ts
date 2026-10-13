import type { NotifyResult } from "./adapters"
import type { HubtelCsStore } from "./store"
import type { HubtelCsTx } from "./types"

export interface OrderHookDeps {
  store: Pick<HubtelCsStore, "markOrderSynced">
  notify(tx: HubtelCsTx): Promise<NotifyResult>
  alertReview(tx: HubtelCsTx): Promise<void>
}

/**
 * The one hook every settle path uses (client, callback, cron, admin actions). Settled rows go to the
 * product's order adapter and are stamped synced only on success, so the cron's re-notify sweep can retry
 * the rest. Rows entering needs_review raise a (debounced) admin alert. Never throws.
 */
export function makeOrderHook(deps: OrderHookDeps): (tx: HubtelCsTx) => Promise<void> {
  return async tx => {
    try {
      if (tx.state === "needs_review") { await deps.alertReview(tx); return }
      const r = await deps.notify(tx)
      if (r === "synced") await deps.store.markOrderSynced(tx.id)
    } catch (e: any) {
      console.error(`[hubtel-cs] order hook failed for ${tx.client_reference}:`, e?.message ?? e)
    }
  }
}
