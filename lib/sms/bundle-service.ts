import { createClient } from "@supabase/supabase-js"
import { bundleVisibleTo, canPurchaseBundle, type OwnerType } from "./foundation-rules"
import { getWholesaleCredits } from "./wholesale"
import { notifyAdminSmsShortfall } from "./notify"
import { isSmsEnabled } from "./kill-switch"

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
  mode: "platform" | "business"
  sort_order: number
}

export interface PurchaseResult {
  ok: boolean
  error?: string
  outcome?: "credited" | "pending" | "duplicate"
  unitsCredited?: number
  pending?: boolean
}

/** Active bundles this owner type is allowed to buy. */
export async function listActiveBundles(ownerType: OwnerType, mode: "platform" | "business" = "platform"): Promise<Bundle[]> {
  const { data } = await supabaseAdmin
    .from("sms_bundles").select("*").eq("active", true).eq("mode", mode)
    .order("sort_order", { ascending: true }).order("price_ghs", { ascending: true })
  return ((data as Bundle[]) ?? []).filter((b) => bundleVisibleTo(b, ownerType, mode))
}

export async function listAllBundles(): Promise<Bundle[]> {
  const { data } = await supabaseAdmin
    .from("sms_bundles").select("*")
    .order("mode", { ascending: true }).order("sort_order", { ascending: true }).order("price_ghs", { ascending: true })
  return (data as Bundle[]) ?? []
}

function assertBundleMode(mode: unknown) {
  if (mode !== "platform" && mode !== "business") throw new Error("mode must be platform or business")
}

export async function createBundle(input: {
  name: string; units: number; price_ghs: number; owner_type_scope?: string
  mode?: "platform" | "business"; sort_order?: number
}) {
  if (input.mode !== undefined) assertBundleMode(input.mode)
  const { data, error } = await supabaseAdmin.from("sms_bundles").insert({
    name: input.name, units: input.units, price_ghs: input.price_ghs,
    owner_type_scope: input.owner_type_scope ?? "all",
    mode: input.mode ?? "platform", sort_order: input.sort_order ?? 0,
  }).select("*").single()
  if (error) throw error
  return data as Bundle
}

export async function updateBundle(
  id: string,
  patch: Partial<{
    name: string; units: number; price_ghs: number; active: boolean; owner_type_scope: string
    mode: "platform" | "business"; sort_order: number
  }>
) {
  if (patch.mode !== undefined) assertBundleMode(patch.mode)
  const { data, error } = await supabaseAdmin.from("sms_bundles")
    .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select("*").single()
  if (error) throw error
  return data as Bundle
}

/** Revenue for the admin "Total Revenue" card (spec §5.8): the GH₵ actually paid, written to the
 *  ledger row and/or the pending row for this ref. Guarded with amount_ghs IS NULL so a redelivery
 *  fills a missing amount but never overwrites one. A pending credit carries the amount on its
 *  pending row; the ledger trigger copies it when the credit settles. Never throws. */
async function recordRevenue(ref: string | null, amountGhs: number | null): Promise<void> {
  if (!ref || amountGhs === null || !(amountGhs > 0)) return
  try {
    const results = await Promise.all([
      supabaseAdmin.from("sms_unit_transactions").update({ amount_ghs: amountGhs }).eq("ref", ref).is("amount_ghs", null),
      supabaseAdmin.from("sms_pending_credits").update({ amount_ghs: amountGhs }).eq("ref", ref).is("amount_ghs", null),
    ])
    for (const r of results) {
      if (r?.error) console.error("[SMS-REVENUE] amount write failed for ref", ref, r.error.message)
    }
  } catch (e) {
    console.error("[SMS-REVENUE] amount write threw for ref", ref, e instanceof Error ? e.message : e)
  }
}

/** Issue units through the solvency gate: fetch the live Moolre wholesale balance, then
 *  credit-or-pend atomically. Notifies admin on a shortfall. Shared by all credit paths. */
async function issueUnits(
  accountId: string, units: number, reason: string, ref: string | null, amountGhs: number | null = null
): Promise<PurchaseResult> {
  const wholesale = await getWholesaleCredits()
  const { data, error } = await supabaseAdmin.rpc("credit_sms_units_if_solvent", {
    p_account_id: accountId, p_units: units, p_reason: reason, p_wholesale: wholesale, p_ref: ref,
  })
  if (error) return { ok: false, error: "Failed to issue units" }
  const outcome = (data as Array<{ outcome: PurchaseResult["outcome"] }>)?.[0]?.outcome
  await recordRevenue(ref, amountGhs)
  if (outcome === "pending") {
    notifyAdminSmsShortfall(units).catch(() => {})
    return { ok: true, outcome, unitsCredited: 0, pending: true }
  }
  return { ok: true, outcome, unitsCredited: outcome === "credited" ? units : 0, pending: false }
}

/** Has this credit ref already landed? Used to avoid a double-refund when an issuance RPC
 *  committed but its response was lost in transit. */
async function refLanded(ref: string): Promise<"credited" | "pending" | null> {
  const { data: tx } = await supabaseAdmin.from("sms_unit_transactions").select("id").eq("ref", ref).maybeSingle()
  if (tx) return "credited"
  const { data: pc } = await supabaseAdmin.from("sms_pending_credits").select("id").eq("ref", ref).maybeSingle()
  if (pc) return "pending"
  return null
}

/** Returns true if the account may purchase bundles or initiate sends. */
export async function isAccountActive(accountId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("sms_accounts").select("status, owner_type").eq("id", accountId).maybeSingle()
  if (!data) return false
  if (data.owner_type === "platform") return true
  return data.status === "active"
}

/** Cash-wallet bundle purchase: race-safe wallet debit, then solvency-gated issuance.
 *  Refunds the cash only if issuance ERRORS (a 'pending' outcome is success, not a failure). */
export async function purchaseBundleViaWallet(userId: string, accountId: string, bundleId: string): Promise<PurchaseResult> {
  if (!(await isSmsEnabled())) return { ok: false, error: "SMS_DISABLED" }
  const { data: bundle } = await supabaseAdmin.from("sms_bundles").select("*").eq("id", bundleId).maybeSingle()
  if (!bundle) return { ok: false, error: "Bundle not found" }
  const b = bundle as Bundle

  // Activation gate: metered accounts must be active. Platform is exempt.
  const { data: acct } = await supabaseAdmin
    .from("sms_accounts").select("status, owner_type, mode").eq("id", accountId).maybeSingle()
  if (acct && acct.owner_type !== "platform" && acct.status !== "active") {
    return { ok: false, error: "NOT_ACTIVATED" }
  }
  // Refuse a bundle from the other mode BEFORE any wallet debit.
  if (b.mode !== ((acct as { mode?: string } | null)?.mode ?? "platform")) {
    return { ok: false, error: "This bundle isn't available for your account mode" }
  }
  const visible = canPurchaseBundle(b, ((acct as { owner_type?: string } | null)?.owner_type ?? "shop") as OwnerType)
  if (!visible.ok) return { ok: false, error: visible.reason }

  const { data: debit, error: debitErr } = await supabaseAdmin.rpc("deduct_wallet", { p_user_id: userId, p_amount: b.price_ghs })
  if (debitErr) return { ok: false, error: "Wallet debit failed" }
  if (!debit || (debit as unknown[]).length === 0) return { ok: false, error: "Insufficient wallet balance" }

  const ref = `wallet-${userId}-${bundleId}-${Date.now()}`
  const res = await issueUnits(accountId, b.units, "bundle_wallet", ref, Number(b.price_ghs))
  if (!res.ok) {
    // The issuance RPC errored. If the credit actually landed (committed but the response
    // was lost), refunding would hand back cash for units the user kept — so only refund
    // when the ref is absent from BOTH the ledger and the pending table.
    const landed = await refLanded(ref)
    if (!landed) {
      await supabaseAdmin.rpc("deduct_wallet", { p_user_id: userId, p_amount: -b.price_ghs }) // refund
      return { ok: false, error: "Failed to credit units (refunded)" }
    }
    await recordRevenue(ref, Number(b.price_ghs))
    return { ok: true, outcome: landed, unitsCredited: landed === "credited" ? b.units : 0, pending: landed === "pending" }
  }
  return res
}

// ── Per-credit pricing (free-quantity top-up) ──────────────────────────────
const DEFAULT_PRICE_PER_CREDIT = 0.04 // GHS, fallback until an admin sets sms_price_per_credit
const MAX_CREDITS_PER_PURCHASE = 100_000

/** The admin-set selling price per SMS credit (GHS), or a sane default if unset. */
export async function getPricePerCredit(): Promise<number> {
  const { data } = await supabaseAdmin
    .from("tenant_global_settings").select("value").eq("key", "sms_price_per_credit").maybeSingle()
  const v = (data as { value?: { amount?: number } | number } | null)?.value
  const amount = typeof v === "object" && v !== null ? v.amount : typeof v === "number" ? v : undefined
  return typeof amount === "number" && amount > 0 ? amount : DEFAULT_PRICE_PER_CREDIT
}

/** Cost (GHS, 2dp) for a quantity of credits at the current per-credit fee. */
export async function quoteCredits(credits: number): Promise<{ pricePerCredit: number; cost: number }> {
  const pricePerCredit = await getPricePerCredit()
  return { pricePerCredit, cost: Math.round(credits * pricePerCredit * 100) / 100 }
}

/** Cash-wallet purchase of an ARBITRARY number of credits at the admin per-credit fee.
 *  Mirrors purchaseBundleViaWallet: server computes the cost, race-safe wallet debit,
 *  solvency-gated issuance, refund only if issuance ERRORS and the ref didn't land. */
export async function purchaseUnitsByQuantity(
  userId: string,
  accountId: string,
  credits: number
): Promise<PurchaseResult & { cost?: number }> {
  if (!(await isSmsEnabled())) return { ok: false, error: "SMS_DISABLED" }
  if (!Number.isInteger(credits) || credits <= 0) return { ok: false, error: "credits must be a positive integer" }
  if (credits > MAX_CREDITS_PER_PURCHASE) return { ok: false, error: `Max ${MAX_CREDITS_PER_PURCHASE.toLocaleString()} credits per purchase` }

  const { data: acct } = await supabaseAdmin
    .from("sms_accounts").select("status, owner_type").eq("id", accountId).maybeSingle()
  if (acct && acct.owner_type !== "platform" && acct.status !== "active") return { ok: false, error: "NOT_ACTIVATED" }

  const { cost } = await quoteCredits(credits)
  if (cost <= 0) return { ok: false, error: "Pricing not configured" }

  const { data: debit, error: debitErr } = await supabaseAdmin.rpc("deduct_wallet", { p_user_id: userId, p_amount: cost })
  if (debitErr) return { ok: false, error: "Wallet debit failed" }
  if (!debit || (debit as unknown[]).length === 0) return { ok: false, error: "Insufficient wallet balance" }

  const ref = `wallet-qty-${userId}-${accountId}-${Date.now()}`
  const res = await issueUnits(accountId, credits, "bundle_wallet", ref, cost)
  if (!res.ok) {
    const landed = await refLanded(ref)
    if (!landed) {
      await supabaseAdmin.rpc("deduct_wallet", { p_user_id: userId, p_amount: -cost }) // refund
      return { ok: false, error: "Failed to credit units (refunded)" }
    }
    await recordRevenue(ref, cost)
    return { ok: true, outcome: landed, unitsCredited: landed === "credited" ? credits : 0, pending: landed === "pending", cost }
  }
  return { ...res, cost }
}

/** Admin manual allocation — also solvency-gated (can land pending). ref=null so repeated
 *  deliberate allocations are never deduped. */
export async function allocateUnits(accountId: string, units: number): Promise<PurchaseResult> {
  if (!Number.isInteger(units) || units <= 0) return { ok: false, error: "units must be a positive integer" }
  return issueUnits(accountId, units, "admin_alloc", null)
}

/** Credit units after a confirmed Paystack SMS-bundle payment. Idempotent on the paystack ref. */
export async function creditUnitsForPaystack(
  accountId: string, units: number, paystackRef: string, amountGhs: number | null = null
): Promise<PurchaseResult> {
  return issueUnits(accountId, units, "bundle_paystack", paystackRef, amountGhs)
}
