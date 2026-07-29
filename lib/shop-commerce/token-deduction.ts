import { createClient } from "@supabase/supabase-js"

// Decides whether a Paystack-webhook order counts as a WhatsApp shop bot sale
// and, if so, deducts the one session token it owes — extracted out of
// app/api/webhooks/paystack/route.ts for testability (the codebase has no
// route-handler test convention under app/api/ — every other task on this
// branch that needed one extracted the money/DB logic into lib/shop-commerce/
// instead; this follows the same seam, e.g. whatsapp-activation.ts).
//
// Design (docs/superpowers/specs/2026-07-29-whatsapp-shop-bot-design.md,
// "Token billing"): USSD deducts its token at session entry
// (lib/ussd-shop/handlers/shop.ts); the WhatsApp channel instead deducts here,
// once per COMPLETED order, when the webhook confirms payment.
//
// shop_code_id availability: ussd_shop_orders carries shop_code_id directly
// (a required NOT NULL column — migrations/ussd_shop_orders.sql). airtime_orders
// and results_checker_orders do NOT have a shop_code_id column — they only
// carry shop_id (user_shops.id). For those two, this resolves the shop's single
// ussd_shop_codes row via shop_id (auto_assign_ussd_shop_code_trigger.sql
// guarantees exactly one code per shop, created atomically alongside the shop
// itself). This is one of the two resolutions the design doc explicitly
// allows for tables that lack the column ("resolve shop_id -> active code in
// the webhook").
//
// Idempotency contract: deduct_ussd_shop_token (migrations/deduct_ussd_shop_token.sql)
// is a plain atomic "decrement if balance>0" — it has NO idempotency of its own,
// so calling it twice for the same order double-bills the shop. Callers MUST
// only invoke this after their own already-processed guard has established that
// this call is the one genuinely transitioning the order from unpaid to paid.
// This module does not (and cannot, without an order id / dedupe table) add a
// second layer of protection — see the callers in app/api/webhooks/paystack/route.ts
// for how each of the three order tables' guard is used to gate the call.

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Using `typeof supabase` (rather than `ReturnType<typeof createClient>`) keeps the
// exact instantiated generic type — createClient's default type params don't survive
// ReturnType applied to the uninstantiated generic function.
type SupabaseClientLike = typeof supabase

export interface DeductibleOrder {
  channel?: string | null
  // Present directly on ussd_shop_orders rows.
  shop_code_id?: string | null
  // Present on airtime_orders / results_checker_orders rows (no shop_code_id
  // column there) — used to resolve the shop's code when shop_code_id is absent.
  shop_id?: string | null
}

export type DeductionResult =
  | { deducted: true }
  | {
      deducted: false
      reason: "not_whatsapp_shop" | "missing_shop_reference" | "shop_code_lookup_failed" | "rpc_error"
      error?: string
    }

export async function deductTokenIfWhatsappShopOrder(
  order: DeductibleOrder,
  client: SupabaseClientLike = supabase
): Promise<DeductionResult> {
  if (order.channel !== "whatsapp_shop") {
    return { deducted: false, reason: "not_whatsapp_shop" }
  }

  let shopCodeId = order.shop_code_id ?? null

  if (!shopCodeId) {
    if (!order.shop_id) {
      return { deducted: false, reason: "missing_shop_reference" }
    }
    const { data, error } = await client
      .from("ussd_shop_codes")
      .select("id")
      .eq("shop_id", order.shop_id)
      .maybeSingle()
    if (error || !data) {
      return { deducted: false, reason: "shop_code_lookup_failed", error: error?.message }
    }
    shopCodeId = data.id
  }

  const { error: deductErr } = await client.rpc("deduct_ussd_shop_token", {
    p_shop_code_id: shopCodeId,
  })
  if (deductErr) {
    return { deducted: false, reason: "rpc_error", error: deductErr.message }
  }
  return { deducted: true }
}
