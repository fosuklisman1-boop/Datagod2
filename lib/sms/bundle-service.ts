import { createClient } from "@supabase/supabase-js"
import { canPurchaseBundle, type OwnerType } from "./foundation-rules"
import { queryMoolreSmsBalance } from "@/lib/sms-service"
import { notifyAdminSmsShortfall } from "./notify"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export interface Bundle {
  id: string
  name: string
  units: number
  price_ghs: number
  owner_type_scope: "all" | OwnerType
  active: boolean
}

export interface PurchaseResult {
  ok: boolean
  error?: string
  outcome?: "credited" | "pending" | "duplicate"
  unitsCredited?: number
  pending?: boolean
}

/** Active bundles this owner type is allowed to buy. */
export async function listActiveBundles(ownerType: OwnerType): Promise<Bundle[]> {
  const { data } = await supabaseAdmin
    .from("sms_bundles").select("*").eq("active", true)
    .order("price_ghs", { ascending: true })
  return ((data as Bundle[]) ?? []).filter((b) => canPurchaseBundle(b, ownerType).ok)
}

export async function listAllBundles(): Promise<Bundle[]> {
  const { data } = await supabaseAdmin
    .from("sms_bundles").select("*").order("price_ghs", { ascending: true })
  return (data as Bundle[]) ?? []
}

export async function createBundle(input: { name: string; units: number; price_ghs: number; owner_type_scope?: string }) {
  const { data, error } = await supabaseAdmin.from("sms_bundles").insert({
    name: input.name, units: input.units, price_ghs: input.price_ghs,
    owner_type_scope: input.owner_type_scope ?? "all",
  }).select("*").single()
  if (error) throw error
  return data as Bundle
}

export async function updateBundle(
  id: string,
  patch: Partial<{ name: string; units: number; price_ghs: number; active: boolean; owner_type_scope: string }>
) {
  const { data, error } = await supabaseAdmin.from("sms_bundles")
    .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select("*").single()
  if (error) throw error
  return data as Bundle
}

/** Issue units through the solvency gate: fetch the live Moolre wholesale balance, then
 *  credit-or-pend atomically. Notifies admin on a shortfall. Shared by all credit paths. */
async function issueUnits(accountId: string, units: number, reason: string, ref: string | null): Promise<PurchaseResult> {
  const wholesale = await queryMoolreSmsBalance()
  const { data, error } = await supabaseAdmin.rpc("credit_sms_units_if_solvent", {
    p_account_id: accountId, p_units: units, p_reason: reason, p_wholesale: wholesale, p_ref: ref,
  })
  if (error) return { ok: false, error: "Failed to issue units" }
  const outcome = (data as Array<{ outcome: PurchaseResult["outcome"] }>)?.[0]?.outcome
  if (outcome === "pending") {
    notifyAdminSmsShortfall(units).catch(() => {})
    return { ok: true, outcome, unitsCredited: 0, pending: true }
  }
  return { ok: true, outcome, unitsCredited: outcome === "credited" ? units : 0, pending: false }
}

/** Cash-wallet bundle purchase: race-safe wallet debit, then solvency-gated issuance.
 *  Refunds the cash only if issuance ERRORS (a 'pending' outcome is success, not a failure). */
export async function purchaseBundleViaWallet(userId: string, accountId: string, bundleId: string): Promise<PurchaseResult> {
  const { data: bundle } = await supabaseAdmin.from("sms_bundles").select("*").eq("id", bundleId).maybeSingle()
  if (!bundle) return { ok: false, error: "Bundle not found" }
  const b = bundle as Bundle

  const { data: debit, error: debitErr } = await supabaseAdmin.rpc("deduct_wallet", { p_user_id: userId, p_amount: b.price_ghs })
  if (debitErr) return { ok: false, error: "Wallet debit failed" }
  if (!debit || (debit as unknown[]).length === 0) return { ok: false, error: "Insufficient wallet balance" }

  const ref = `wallet-${userId}-${bundleId}-${Date.now()}`
  const res = await issueUnits(accountId, b.units, "bundle_wallet", ref)
  if (!res.ok) {
    await supabaseAdmin.rpc("deduct_wallet", { p_user_id: userId, p_amount: -b.price_ghs }) // refund
    return { ok: false, error: "Failed to credit units (refunded)" }
  }
  return res
}

/** Admin manual allocation — also solvency-gated (can land pending). ref=null so repeated
 *  deliberate allocations are never deduped. */
export async function allocateUnits(accountId: string, units: number): Promise<PurchaseResult> {
  if (!Number.isInteger(units) || units <= 0) return { ok: false, error: "units must be a positive integer" }
  return issueUnits(accountId, units, "admin_alloc", null)
}

/** Credit units after a confirmed Paystack SMS-bundle payment. Idempotent on the paystack ref. */
export async function creditUnitsForPaystack(accountId: string, units: number, paystackRef: string): Promise<PurchaseResult> {
  return issueUnits(accountId, units, "bundle_paystack", paystackRef)
}
