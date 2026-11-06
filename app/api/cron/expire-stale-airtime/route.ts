import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { expireStaleShopOrders } from "@/lib/payments/expire-shop-orders"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Orders unpaid for longer than this are considered abandoned
const EXPIRY_MINUTES = 30

export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!

  try {
    const cutoff = new Date(Date.now() - EXPIRY_MINUTES * 60 * 1000).toISOString()

    // 1) Airtime orders
    const { data: airtimeExpired, error: airtimeErr } = await supabase
      .from("airtime_orders")
      .update({ status: "expired", payment_status: "expired", updated_at: new Date().toISOString() })
      .eq("status", "pending_payment")
      .eq("payment_status", "pending_payment")
      .lt("created_at", cutoff)
      .select("id")

    if (airtimeErr) {
      console.error("[EXPIRE-STALE] airtime_orders DB error:", airtimeErr)
    }

    // 2) Shop (data) orders — CRITICAL: unpaid flood orders that never expire
    //    accumulate in the per-shop pending cap and block legitimate customers.
    //    Expiring them frees the cap so real buyers aren't locked out during an
    //    attack. Only touches payment_status='pending' rows (paid orders already
    //    flipped to 'completed' by the webhook, so they're untouched).
    //    An order with a live Hubtel attempt is skipped: the customer may still be paying.
    let shopExpired = 0
    try {
      shopExpired = await expireStaleShopOrders(supabase, cutoff)
    } catch (shopErr) {
      console.error("[EXPIRE-STALE] shop_orders DB error:", shopErr instanceof Error ? shopErr.message : "unknown error")
    }

    // 3) Results-checker orders
    const { data: rcExpired, error: rcErr } = await supabase
      .from("results_checker_orders")
      .update({ status: "expired", payment_status: "expired", updated_at: new Date().toISOString() })
      .eq("status", "pending_payment")
      .eq("payment_status", "pending_payment")
      .lt("created_at", cutoff)
      .select("id")

    if (rcErr) {
      console.error("[EXPIRE-STALE] results_checker_orders DB error:", rcErr)
    }

    const result = {
      airtime: airtimeExpired?.length ?? 0,
      shop: shopExpired,
      results_checker: rcExpired?.length ?? 0,
    }
    console.log(`[EXPIRE-STALE] Expired stale pending orders (cutoff ${cutoff}):`, result)

    return NextResponse.json({ expired: result })
  } catch (err) {
    console.error("[EXPIRE-STALE] Unexpected error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
