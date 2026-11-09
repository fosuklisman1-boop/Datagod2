// A web start that refused after its wallet_payments row was written (payment_method 'hubtel') leaves that row pending.
// The Paystack verifiers skip Hubtel rows, so nothing would ever close it, and the R2 replay would keep picking it up.
// Close it, but only when no Hubtel attempt for it may hold money: an open, paid or parked attempt keeps the row, and the
// confirm path settles it. Never throws.
import type { SupabaseClient } from "@supabase/supabase-js"
import { findHubtelPaymentByInternalRef, isLiveHubtelStatus } from "@/lib/hubtel-pay/lookup"

export type CloseRefusedResult = "closed" | "left_open" | "error"

export async function closeRefusedHubtelWalletPayment(db: SupabaseClient, reference: string): Promise<CloseRefusedResult> {
  try {
    const attempt = await findHubtelPaymentByInternalRef(db, reference)
    if (attempt && isLiveHubtelStatus(attempt.status)) return "left_open"
  } catch (e) {
    console.error("[PAYMENT-INIT] refused start: attempt lookup failed, row left open:", e instanceof Error ? e.message : "unknown error")
    return "left_open"
  }
  try {
    const { error } = await db
      .from("wallet_payments")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("reference", reference)
      .eq("status", "pending")
      .eq("payment_method", "hubtel")
      .select("id")
    if (error) {
      console.error("[PAYMENT-INIT] refused start: could not close the payment row:", error.message)
      return "error"
    }
    return "closed"
  } catch (e) {
    console.error("[PAYMENT-INIT] refused start: could not close the payment row:", e instanceof Error ? e.message : "unknown error")
    return "error"
  }
}
