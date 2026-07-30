import { createClient } from "@supabase/supabase-js"

// Atomic "claim-then-pay" WhatsApp shop activation. Extracted out of
// app/api/dashboard/ussd-shop/whatsapp-activate/route.ts for testability (the
// codebase has no route-handler test convention under app/api/ — every other
// task on this branch extracted the money/DB logic into lib/shop-commerce/
// instead, so this follows the same seam).
//
// Concurrency: a double-click or client retry-on-timeout can fire two POSTs
// for the same shop code before either has committed. The OLD implementation
// read `whatsapp_activated`, decided "not yet activated", and only wrote the
// flag back AFTER deducting the wallet — so two concurrent requests could both
// pass the read-based check and both successfully deduct, double-charging the
// shop owner for one activation. The fix: CLAIM the activation first via a
// conditional UPDATE (`.eq("whatsapp_activated", false)`) — Postgres guarantees
// only one of two concurrent UPDATEs matching the same row can see
// whatsapp_activated still false, so only one caller ever gets a non-null row
// back and proceeds to touch money. The loser gets a clean "already activated"
// with the wallet never touched. If the wallet deduction fails AFTER the claim
// succeeds (e.g. insufficient balance), the claim is rolled back so the shop
// code isn't left falsely marked activated with no payment behind it.

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Using `typeof supabase` (rather than `ReturnType<typeof createClient>`) keeps the
// exact instantiated generic type — createClient's default type params don't survive
// ReturnType applied to the uninstantiated generic function.
type SupabaseClientLike = typeof supabase

export interface ActivateWhatsappShopInput {
  shopCodeId: string
  shopId: string
  userId: string
  fee: number
}

export type ActivateWhatsappShopResult =
  | { ok: true }
  | { ok: false; status: number; error: string }

export async function activateWhatsappShop(
  input: ActivateWhatsappShopInput,
  client: SupabaseClientLike = supabase
): Promise<ActivateWhatsappShopResult> {
  const { shopCodeId, shopId, userId, fee } = input

  // ── 1. Claim — the atomic concurrency guard. No money has moved yet. ──────
  const { data: claimed, error: claimErr } = await client
    .from("ussd_shop_codes")
    .update({
      whatsapp_activated: true,
      whatsapp_activated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", shopCodeId)
    .eq("whatsapp_activated", false) // <-- only one concurrent request can match this
    .select("id")
    .maybeSingle()

  if (claimErr) {
    console.error("[WHATSAPP-ACTIVATE] Failed to claim activation:", claimErr)
    return { ok: false, status: 500, error: "Activation failed — please contact support" }
  }
  if (!claimed) {
    // Someone else already activated it (or a concurrent request won the race) —
    // no charge, no wallet touch.
    return { ok: false, status: 409, error: "Already activated" }
  }

  // ── 2. Pay — only the single claim winner reaches here. ───────────────────
  const { data: deductResult, error: deductError } = await client.rpc("deduct_wallet", {
    p_user_id: userId,
    p_amount: fee,
  })

  if (deductError || !deductResult || deductResult.length === 0) {
    // Roll back the claim — the shop owner was never charged, so the code must
    // not be left marked activated.
    const { error: rollbackErr } = await client
      .from("ussd_shop_codes")
      .update({ whatsapp_activated: false, whatsapp_activated_at: null, updated_at: new Date().toISOString() })
      .eq("id", shopCodeId)
    if (rollbackErr) console.error("[WHATSAPP-ACTIVATE] Failed to roll back claim after deduction failure:", rollbackErr)
    return { ok: false, status: 402, error: "Insufficient wallet balance" }
  }

  const { new_balance: newBalance, old_balance: balanceBefore } = deductResult[0]

  await client.from("transactions").insert([{
    user_id: userId,
    type: "debit",
    source: "whatsapp_shop_activation",
    amount: fee,
    balance_before: balanceBefore,
    balance_after: newBalance,
    description: "WhatsApp shop activation fee",
    reference_id: shopCodeId,
    status: "completed",
    created_at: new Date().toISOString(),
  }]).then(({ error }) => { if (error) console.warn("[WHATSAPP-ACTIVATE] tx insert failed:", error) })

  await client.from("ussd_shop_token_purchases").insert([{
    shop_code_id: shopCodeId,
    shop_id: shopId,
    tokens_purchased: 0,
    amount_paid: fee,
    payment_method: "wallet",
    payment_status: "completed",
    is_whatsapp_activation: true,
  }])

  return { ok: true }
}

// Admin-granted WhatsApp activation — no wallet charge. Mirrors the existing
// USSD-side admin /activate endpoint's "manual activation" pattern
// (app/api/admin/ussd-shops/[id]/activate/route.ts): the shop owner gets
// access without going through the real paid flow, but the same
// ussd_shop_token_purchases row shape is still logged (amount_paid: 0,
// payment_method: 'manual') so admin-granted and customer-paid activations
// report consistently anywhere ussd_shop_token_purchases is aggregated.
// Uses the same conditional-UPDATE "claim" pattern as activateWhatsappShop
// so a double-click can't log two purchase rows for one activation.
export interface AdminGrantWhatsappShopInput {
  shopCodeId: string
  shopId: string
}

export type AdminGrantWhatsappShopResult =
  | { ok: true }
  | { ok: false; status: number; error: string }

export async function adminGrantWhatsappShop(
  input: AdminGrantWhatsappShopInput,
  client: SupabaseClientLike = supabase
): Promise<AdminGrantWhatsappShopResult> {
  const { shopCodeId, shopId } = input

  const { data: claimed, error: claimErr } = await client
    .from("ussd_shop_codes")
    .update({
      whatsapp_activated: true,
      whatsapp_activated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", shopCodeId)
    .eq("whatsapp_activated", false)
    .select("id")
    .maybeSingle()

  if (claimErr) {
    console.error("[ADMIN-WHATSAPP-GRANT] Failed to update shop code:", claimErr)
    return { ok: false, status: 500, error: "Grant failed — database update error" }
  }
  if (!claimed) {
    return { ok: false, status: 409, error: "Already activated" }
  }

  await client.from("ussd_shop_token_purchases").insert([{
    shop_code_id: shopCodeId,
    shop_id: shopId,
    tokens_purchased: 0,
    amount_paid: 0,
    payment_method: "manual",
    payment_status: "completed",
    is_whatsapp_activation: true,
  }])

  return { ok: true }
}

// Manual revoke — a pure access-flag toggle, no refund/reversal logic. Any fee
// the shop owner previously paid (real or manually-granted) stays an
// unaffected historical ussd_shop_token_purchases/transactions record.
export interface AdminRevokeWhatsappShopInput {
  shopCodeId: string
}

export type AdminRevokeWhatsappShopResult =
  | { ok: true }
  | { ok: false; status: number; error: string }

export async function adminRevokeWhatsappShop(
  input: AdminRevokeWhatsappShopInput,
  client: SupabaseClientLike = supabase
): Promise<AdminRevokeWhatsappShopResult> {
  const { shopCodeId } = input

  const { data: claimed, error } = await client
    .from("ussd_shop_codes")
    .update({
      whatsapp_activated: false,
      whatsapp_activated_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", shopCodeId)
    .eq("whatsapp_activated", true)
    .select("id")
    .maybeSingle()

  if (error) {
    console.error("[ADMIN-WHATSAPP-REVOKE] Failed to update shop code:", error)
    return { ok: false, status: 500, error: "Revoke failed — database update error" }
  }
  if (!claimed) {
    return { ok: false, status: 409, error: "Not currently activated" }
  }

  return { ok: true }
}
