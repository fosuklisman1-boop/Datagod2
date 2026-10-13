import type { SupabaseClient } from "@supabase/supabase-js"
import type { HubtelCsEvent, HubtelCsPatch, HubtelCsState, HubtelCsTx, NewHubtelCsTx } from "./types"

export interface ListOpts { state?: HubtelCsState | "attention"; q?: string; qAlt?: string; limit: number; offset: number }
export interface UpdateGuard { refundUnclaimed?: boolean }
export interface HubtelCsStats { total: number; in_flight: number; needs_review: number; failed: number; fulfilled: number; commission_earned: number }

export interface HubtelCsStore {
  insert(row: NewHubtelCsTx): Promise<HubtelCsTx>
  getByRef(ref: string): Promise<HubtelCsTx | null>
  /** Guarded write; with `guard.refundUnclaimed` it additionally requires refund_claimed_at IS NULL (a refund claim wins). */
  updateGuarded(id: string, expectedState: HubtelCsState, patch: HubtelCsPatch, guard?: UpdateGuard): Promise<HubtelCsTx | null>
  listByStates(states: HubtelCsState[], o: { olderThan?: string; limit: number; orderBy?: "created_at" | "last_status_check_at" }): Promise<HubtelCsTx[]>
  listForAdmin(o: ListOpts): Promise<{ rows: HubtelCsTx[]; total: number }>
  stats(): Promise<HubtelCsStats>
  logEvent(ev: HubtelCsEvent): Promise<void>
  /** Atomically claim a refund: only succeeds on a failed row with no prior claim. Null otherwise. */
  claimRefund(id: string, adminId: string): Promise<HubtelCsTx | null>
  /** Clear a claim; only when the adapter explicitly reports nothing was refunded. */
  releaseRefundClaim(id: string): Promise<void>
  purgeEventsOlderThan(iso: string): Promise<void>
}

const T = "hubtel_cs_transactions"
const E = "hubtel_cs_events"

/** Strip characters that would break a PostgREST `.or()` filter or act as ilike wildcards. */
const safeSearch = (q: string) => q.replace(/[,()%*\\":]/g, "").trim()

export function createSupabaseHubtelCsStore(db: SupabaseClient): HubtelCsStore {
  let warned = false
  return {
    async insert(row) {
      const { data, error } = await db.from(T).insert(row).select().single()
      if (error) throw error
      return data as HubtelCsTx
    },
    async getByRef(ref) {
      const { data, error } = await db.from(T).select("*").eq("client_reference", ref).maybeSingle()
      if (error) throw error
      return (data as HubtelCsTx | null) ?? null
    },
    async updateGuarded(id, expectedState, patch, guard) {
      const withTs = { ...patch, updated_at: patch.updated_at ?? new Date().toISOString() }
      let q = db.from(T).update(withTs).eq("id", id).eq("state", expectedState)
      if (guard?.refundUnclaimed) q = q.is("refund_claimed_at", null)
      const { data, error } = await q.select().maybeSingle()
      if (error) throw error
      return (data as HubtelCsTx | null) ?? null
    },
    async claimRefund(id, adminId) {
      const ts = new Date().toISOString()
      const { data, error } = await db.from(T).update({ refund_claimed_at: ts, refund_claimed_by: adminId, updated_at: ts })
        .eq("id", id).eq("state", "failed").is("refund_claimed_at", null).select().maybeSingle()
      if (error) throw error
      return (data as HubtelCsTx | null) ?? null
    },
    async releaseRefundClaim(id) {
      const { error } = await db.from(T).update({ refund_claimed_at: null, refund_claimed_by: null, updated_at: new Date().toISOString() }).eq("id", id)
      if (error) throw error
    },
    async listByStates(states, o) {
      let q = db.from(T).select("*").in("state", states)
      if (o.olderThan) q = q.lte("created_at", o.olderThan)
      const { data, error } = await q.order(o.orderBy ?? "created_at", { ascending: true, nullsFirst: true }).limit(o.limit)
      if (error) throw error
      return (data ?? []) as HubtelCsTx[]
    },
    async listForAdmin(o) {
      let q = db.from(T).select("*", { count: "exact" })
      if (o.state === "attention") q = q.in("state", ["needs_review", "failed"])
      else if (o.state) q = q.eq("state", o.state)
      const term = o.q ? safeSearch(o.q) : ""
      const alt = o.qAlt ? safeSearch(o.qAlt) : ""
      if (term) {
        const parts = [`client_reference.ilike.%${term}%`, `destination.ilike.%${term}%`, `hubtel_transaction_id.ilike.%${term}%`]
        if (alt && alt !== term) parts.push(`destination.ilike.%${alt}%`)
        q = q.or(parts.join(","))
      }
      const { data, error, count } = await q.order("created_at", { ascending: false }).range(o.offset, o.offset + o.limit - 1)
      if (error) throw error
      return { rows: (data ?? []) as HubtelCsTx[], total: count ?? 0 }
    },
    async stats() {
      const { data, error } = await db.rpc("hubtel_cs_stats")
      if (error) throw error
      const r: any = Array.isArray(data) ? data[0] : data
      return {
        total: Number(r?.total ?? 0), in_flight: Number(r?.in_flight ?? 0), needs_review: Number(r?.needs_review ?? 0),
        failed: Number(r?.failed ?? 0), fulfilled: Number(r?.fulfilled ?? 0), commission_earned: Number(r?.commission_earned ?? 0),
      }
    },
    async logEvent(ev) {
      try {
        const { error } = await db.from(E).insert(ev)
        if (error && !warned) { warned = true; console.warn("[hubtel-cs] event log insert failed (migration 0114 applied?):", error.message) }
      } catch (e: any) {
        if (!warned) { warned = true; console.warn("[hubtel-cs] event log threw:", e?.message ?? e) }
      }
    },
    async purgeEventsOlderThan(iso) {
      try { await db.from(E).delete().lt("created_at", iso) } catch { /* retention is best-effort */ }
    },
  }
}
