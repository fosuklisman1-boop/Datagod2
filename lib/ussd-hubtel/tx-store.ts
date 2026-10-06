// lib/ussd-hubtel/tx-store.ts
import type { SupabaseClient } from "@supabase/supabase-js"
import type { HubtelTxRow, HubtelTxStore } from "./types"
import { INDETERMINATE_RECHECK_MAX_AGE_MS, INDETERMINATE_RECHECK_MAX_ATTEMPTS } from "./status-check"

export function createSupabaseTxStore(supabase: SupabaseClient): HubtelTxStore {
  return {
    async findBySession(sessionId) {
      const { data, error } = await supabase.from("hubtel_transactions").select("*").eq("session_id", sessionId).maybeSingle()
      if (error) throw error
      return (data as HubtelTxRow | null) ?? null
    },
    async claim(sessionId, from = ["awaiting_payment"], where) {
      let q = supabase
        .from("hubtel_transactions")
        .update({ state: "processing", updated_at: new Date().toISOString() })
        .eq("session_id", sessionId)
        .in("state", from)
      if (where?.callback_status) q = q.eq("callback_status", where.callback_status)
      if (where?.paid_atIsNull) q = q.is("paid_at", null)
      const { data, error } = await q.select("session_id")
      if (error) throw error
      return (data?.length ?? 0) === 1
    },
    async update(sessionId, patch) {
      const { error } = await supabase
        .from("hubtel_transactions")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("session_id", sessionId)
      if (error) throw error
    },
    async updateIf(sessionId, expect, patch) {
      let q = supabase
        .from("hubtel_transactions")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("session_id", sessionId)
        .eq("state", expect.state)
      if (expect.callback_status) q = q.eq("callback_status", expect.callback_status)
      if (expect.paid_atIsNull) q = q.is("paid_at", null)
      const { data, error } = await q.select("session_id")
      if (error) throw error
      return (data?.length ?? 0) === 1
    },
    async listPendingCallbacks(limit) {
      const { data, error } = await supabase
        .from("hubtel_transactions").select("*").eq("callback_status", "pending")
        .order("paid_at", { ascending: true }).limit(limit)
      if (error) throw error
      return (data ?? []) as HubtelTxRow[]
    },
    async listAwaitingPayment(limit) {
      const { data, error } = await supabase
        .from("hubtel_transactions").select("*").eq("state", "awaiting_payment")
        .order("created_at", { ascending: true }).limit(limit)
      if (error) throw error
      return (data ?? []) as HubtelTxRow[]
    },
    async listStaleProcessing(olderThanMinutes, limit) {
      const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString()
      const { data, error } = await supabase
        .from("hubtel_transactions").select("*").eq("state", "processing").lt("updated_at", cutoff)
        .order("updated_at", { ascending: true }).limit(limit)
      if (error) throw error
      return (data ?? []) as HubtelTxRow[]
    },
    async listIndeterminate(limit) {
      const { data, error } = await supabase
        .from("hubtel_transactions").select("*")
        .eq("state", "needs_review").eq("callback_status", "not_due").is("paid_at", null)
        // Same caps as indeterminateRecheckDisposition, applied in the query so exhausted rows
        // (which stay parked until a human resolves them) never fill the limit and starve newer ones.
        .lt("status_check_attempts", INDETERMINATE_RECHECK_MAX_ATTEMPTS)
        .gt("created_at", new Date(Date.now() - INDETERMINATE_RECHECK_MAX_AGE_MS).toISOString())
        .order("created_at", { ascending: true }).limit(limit)
      if (error) throw error
      return (data ?? []) as HubtelTxRow[]
    },
  }
}
