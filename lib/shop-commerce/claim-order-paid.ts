import { createClient } from "@supabase/supabase-js"

// Atomically "claims" a ussd_shop_orders row as paid — extracted out of
// app/api/webhooks/paystack/route.ts so the race-safety of the UPDATE itself
// is independently testable (the codebase has no route-handler test
// convention under app/api/; see lib/shop-commerce/whatsapp-activation.ts for
// the same extraction seam, whose claim-then-pay pattern this mirrors).
//
// Why this exists: two near-simultaneous duplicate Paystack webhook
// deliveries for the same order can both READ payment_status as
// 'pending'/'otp_required' before either commits an UPDATE. An unconditional
// UPDATE (or one only guarded by a prior read) lets both deliveries "win" and
// both proceed to deduct a WhatsApp shop token / credit profit / trigger
// fulfillment for the same order — a double-bill. Putting the pre-state check
// ON the UPDATE itself (`.in("payment_status", [...])`) closes that gap:
// Postgres only lets one of two concurrent UPDATEs matching the same row id
// also match the payment_status filter — the loser's UPDATE affects zero
// rows, `claimed` comes back false, and the caller must skip deduction,
// profit-crediting, and fulfillment for that delivery (the winner already
// did/will do them).

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Using `typeof supabase` (rather than `ReturnType<typeof createClient>`) keeps the
// exact instantiated generic type — createClient's default type params don't survive
// ReturnType applied to the uninstantiated generic function.
type SupabaseClientLike = typeof supabase

export type ClaimPaidResult =
  | { claimed: true }
  | { claimed: false; error?: string }

// Pre-paid states a ussd_shop_orders row may be in before this webhook call —
// mirrors the read-side guard in app/api/webhooks/paystack/route.ts
// (`payment_status !== 'pending' && !== 'otp_required'` -> already processed).
const CLAIMABLE_STATUSES = ["pending", "otp_required"] as const

export async function claimUssdShopOrderPaid(
  orderId: string,
  paystackReference: string,
  client: SupabaseClientLike = supabase
): Promise<ClaimPaidResult> {
  const { data, error } = await client
    .from("ussd_shop_orders")
    .update({
      payment_status: "completed",
      paystack_reference: paystackReference,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderId)
    .in("payment_status", CLAIMABLE_STATUSES as unknown as string[])
    .select("id")
    .maybeSingle()

  if (error) return { claimed: false, error: error.message }
  return { claimed: !!data }
}
