import { randomUUID } from "crypto"
import type { HubtelCsStats, HubtelCsStore, ListOpts } from "../store"
import type { HubtelCsEvent, HubtelCsPatch, HubtelCsState, HubtelCsTx, NewHubtelCsTx } from "../types"
import { makeTx } from "./fixtures"

export function createMemoryStore(): HubtelCsStore & { rows: HubtelCsTx[]; events: HubtelCsEvent[]; seed(tx: HubtelCsTx): HubtelCsTx } {
  const rows: HubtelCsTx[] = []
  const events: HubtelCsEvent[] = []
  const nowIso = () => new Date().toISOString()
  return {
    rows, events,
    seed(tx) { rows.push({ ...tx }); return tx },
    async insert(row: NewHubtelCsTx) {
      if (rows.some(r => r.client_reference === row.client_reference)) throw new Error("duplicate key value violates unique constraint (client_reference)")
      if (row.order_id && rows.some(r => r.order_table === (row.order_table ?? null) && r.order_id === row.order_id && r.state !== "failed")) {
        throw new Error("duplicate key value violates unique constraint hubtel_cs_tx_order_active_uidx")
      }
      const tx = makeTx({ ...row, id: randomUUID(), state: "created", bundle: row.bundle ?? null, extra: row.extra ?? null, order_table: row.order_table ?? null, order_id: row.order_id ?? null, created_at: nowIso(), updated_at: nowIso() })
      rows.push(tx)
      return { ...tx }
    },
    async getByRef(ref) { const r = rows.find(x => x.client_reference === ref); return r ? { ...r } : null },
    async updateGuarded(id, expectedState: HubtelCsState, patch: HubtelCsPatch, guard) {
      const r = rows.find(x => x.id === id && x.state === expectedState)
      if (!r) return null
      if (guard?.refundUnclaimed && r.refund_claimed_at) return null
      // Mirror the per-order partial unique index (one non-failed row per order).
      if (patch.state && patch.state !== "failed" && r.order_id &&
          rows.some(o => o.id !== r.id && o.order_table === r.order_table && o.order_id === r.order_id && o.state !== "failed")) {
        throw new Error("duplicate key value violates unique constraint hubtel_cs_tx_order_active_uidx")
      }
      Object.assign(r, patch, { updated_at: patch.updated_at ?? nowIso() })
      return { ...r }
    },
    async claimRefund(id, adminId) {
      const r = rows.find(x => x.id === id && x.state === "failed" && !x.refund_claimed_at)
      if (!r) return null
      Object.assign(r, { refund_claimed_at: nowIso(), refund_claimed_by: adminId, updated_at: nowIso() })
      return { ...r }
    },
    async releaseRefundClaim(id) {
      const r = rows.find(x => x.id === id)
      if (r) Object.assign(r, { refund_claimed_at: null, refund_claimed_by: null, updated_at: nowIso() })
    },
    async markOrderSyncAttempt(id: string) {
      const r = rows.find(x => x.id === id)
      if (r) r.order_sync_attempted_at = nowIso()
    },
    async markOrderSynced(id: string) {
      const r = rows.find(x => x.id === id)
      if (r) r.order_synced_at = nowIso()
    },
    async listUnsynced(o: { olderThan: string; limit: number }) {
      return rows
        .filter(r => (r.state === "fulfilled" || r.state === "failed") && r.order_table && !r.order_synced_at && r.updated_at <= o.olderThan && (!r.order_sync_attempted_at || r.order_sync_attempted_at <= o.olderThan))
        .sort((a, b) => (a.order_sync_attempted_at ?? "").localeCompare(b.order_sync_attempted_at ?? "") || a.updated_at.localeCompare(b.updated_at))
        .slice(0, o.limit)
        .map(r => ({ ...r }))
    },
    async listByStates(states, o) {
      const out = rows
        .filter(r => states.includes(r.state) && (!o.olderThan || r.created_at <= o.olderThan))
        .sort((a, b) => {
          const k = o.orderBy ?? "created_at"
          const av = (a as any)[k] as string | null, bv = (b as any)[k] as string | null
          if (av === bv) return 0
          if (av === null) return -1
          if (bv === null) return 1
          return av < bv ? -1 : 1
        })
        .slice(0, o.limit)
      return out.map(r => ({ ...r }))
    },
    async listForAdmin(o: ListOpts) {
      const term = (o.q ?? "").toLowerCase()
      const filtered = rows
        .filter(r => (o.state === "attention" ? r.state === "needs_review" || r.state === "failed" : o.state ? r.state === o.state : true))
        .filter(r => !term || [r.client_reference, r.destination, r.hubtel_transaction_id ?? ""].some(v => v.toLowerCase().includes(term)))
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      return { rows: filtered.slice(o.offset, o.offset + o.limit).map(r => ({ ...r })), total: filtered.length }
    },
    async stats(): Promise<HubtelCsStats> {
      const count = (f: (r: HubtelCsTx) => boolean) => rows.filter(f).length
      return {
        total: rows.length,
        in_flight: count(r => r.state === "created" || r.state === "pending"),
        needs_review: count(r => r.state === "needs_review"),
        failed: count(r => r.state === "failed"),
        fulfilled: count(r => r.state === "fulfilled"),
        commission_earned: rows.filter(r => r.state === "fulfilled").reduce((s, r) => s + (r.commission ?? 0), 0),
      }
    },
    async logEvent(ev) { events.push(ev) },
    async purgeEventsOlderThan() { /* memory store keeps no timestamps */ },
  }
}
