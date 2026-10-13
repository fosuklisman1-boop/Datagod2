// lib/ussd-hubtel/billing-guard.ts
// Shop-mode token billing guard: at most ONE shop session token per (Hubtel SessionId, shop code).
// The Uzo shop code deducts a token every time a code is accepted and relies only on the session
// moving past the code step to avoid a second deduction. Hubtel can redeliver a request (lost
// reply, retry) and a "Session expired" restart re-asks for the code within the same SessionId,
// so the claim is an explicit marker row (hubtel_shop_billing_claims, migration 0111) inserted
// BEFORE deduct_ussd_shop_token runs. The table's primary key makes the insert the atomic test.
// It lives in Postgres, not Redis, so a Redis outage cannot block shop codes.
//
// Release contract: the caller releases the marker ONLY when the outcome is DEFINITELY "not
// deducted" (token balance <= 0 seen before the RPC, or the RPC returned false). On a thrown or
// errored RPC the marker is KEPT and the code refused ("Shop unavailable"): an RPC error (timeout,
// 504) can hide a committed deduction, and releasing would let a retry charge twice. Worst case
// is one free session (decision D3).
import type { SupabaseClient } from "@supabase/supabase-js"
import { safeDbError } from "./log-safe"

export type BillingClaim = "claimed" | "already" | "error"

export interface ShopBillingGuard {
  /** "claimed": this call may deduct. "already": this session already paid for this code. "error": guard unavailable, do NOT deduct. */
  claim(sessionId: string, shopCodeId: string): Promise<BillingClaim>
  /**
   * Undo a claim whose deduction DEFINITELY did not happen (balance <= 0 before the RPC, or the RPC
   * returned false). Never call this after a thrown/errored RPC: the deduction may have committed.
   */
  release(sessionId: string, shopCodeId: string): Promise<void>
}

const TABLE = "hubtel_shop_billing_claims"
const UNIQUE_VIOLATION = "23505"

export function dbShopBillingGuard(supabase: SupabaseClient): ShopBillingGuard {
  return {
    async claim(sessionId, shopCodeId) {
      try {
        const { error } = await supabase.from(TABLE).insert({ session_id: sessionId, shop_code_id: shopCodeId })
        if (!error) return "claimed"
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) return "already"
        console.error("[HUBTEL-SHOP-BILLING] claim failed for", sessionId, ":", safeDbError(error))
        return "error"
      } catch (e) {
        console.error("[HUBTEL-SHOP-BILLING] claim threw for", sessionId, ":", safeDbError(e))
        return "error"
      }
    },
    async release(sessionId, shopCodeId) {
      // If this fails the marker stays: this session may re-enter the code once without a
      // deduction (logged). Never deduct to compensate.
      try {
        const { error } = await supabase.from(TABLE).delete().eq("session_id", sessionId).eq("shop_code_id", shopCodeId)
        if (error) console.error("[HUBTEL-SHOP-BILLING] release failed for", sessionId, ":", safeDbError(error))
      } catch (e) {
        console.error("[HUBTEL-SHOP-BILLING] release threw for", sessionId, ":", safeDbError(e))
      }
    },
  }
}
