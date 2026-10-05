// lib/ussd-hubtel/tx-store.ts
import type { SupabaseClient } from "@supabase/supabase-js"
import type { HubtelTxRow, HubtelTxStore } from "./types"

export function createSupabaseTxStore(supabase: SupabaseClient): HubtelTxStore {
  return {
    async findBySession(sessionId) {
      const { data, error } = await supabase.from("hubtel_transactions").select("*").eq("session_id", sessionId).maybeSingle()
      if (error) throw error
      return (data as HubtelTxRow | null) ?? null
    },
    async claim(sessionId) {
      const { data, error } = await supabase
        .from("hubtel_transactions")
        .update({ state: "processing", updated_at: new Date().toISOString() })
        .eq("session_id", sessionId)
        .eq("state", "awaiting_payment")
        .select("session_id")
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
  }
}
