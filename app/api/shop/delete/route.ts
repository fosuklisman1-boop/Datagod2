import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// Self-service shop deletion. Every FK referencing user_shops(id) is either
// ON DELETE CASCADE (shop_orders, shop_profits, shop_available_balance,
// shop_settings, withdrawal_requests, wallet_payments, payment_attempts,
// shop_customers, shop_packages, ussd_shop_codes/orders/token_purchases, etc.)
// or ON DELETE SET NULL (airtime_orders, results_checker_orders,
// results_check_requests, ussd_afa_orders, custom_domains.linked_shop_id) --
// verified live via information_schema before building this. So deleting the
// row is always safe from an FK-violation standpoint; the guards below exist
// to stop an owner from accidentally destroying money that hasn't been paid
// out yet, not to prevent the delete itself from erroring.
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(authHeader.slice(7))
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }
  const { shopId, confirmName } = body || {}
  if (!shopId || typeof confirmName !== "string") {
    return NextResponse.json({ error: "Missing shopId or confirmName" }, { status: 400 })
  }

  const { data: shop, error: shopErr } = await supabaseAdmin
    .from("user_shops")
    .select("id, user_id, shop_name")
    .eq("id", shopId)
    .maybeSingle()
  if (shopErr) {
    console.error("[SHOP-DELETE] Shop lookup failed:", shopErr.message)
    return NextResponse.json({ error: "Could not verify shop ownership" }, { status: 500 })
  }
  if (!shop || shop.user_id !== user.id) {
    return NextResponse.json({ error: "You do not have permission to delete this shop" }, { status: 403 })
  }

  if (confirmName.trim().toLowerCase() !== (shop.shop_name || "").trim().toLowerCase()) {
    return NextResponse.json({ error: "Shop name confirmation does not match" }, { status: 400 })
  }

  const { data: balanceRow } = await supabaseAdmin
    .from("shop_available_balance")
    .select("available_balance")
    .eq("shop_id", shopId)
    .maybeSingle()
  const availableBalance = Number(balanceRow?.available_balance ?? 0)
  if (availableBalance > 0.01) {
    return NextResponse.json(
      { error: `You have GHS ${availableBalance.toFixed(2)} in unwithdrawn profit. Withdraw it before deleting your shop.` },
      { status: 400 }
    )
  }

  const { data: inflightWithdrawals } = await supabaseAdmin
    .from("withdrawal_requests")
    .select("id")
    .eq("shop_id", shopId)
    .in("status", ["pending", "processing", "approved"])
    .limit(1)
  if (inflightWithdrawals && inflightWithdrawals.length > 0) {
    return NextResponse.json(
      { error: "You have a withdrawal request in progress. Wait for it to complete before deleting your shop." },
      { status: 400 }
    )
  }

  const { error: deleteErr } = await supabaseAdmin
    .from("user_shops")
    .delete()
    .eq("id", shopId)
    .eq("user_id", user.id)
  if (deleteErr) {
    console.error("[SHOP-DELETE] Delete failed:", deleteErr.message)
    return NextResponse.json({ error: "Failed to delete shop" }, { status: 500 })
  }

  console.log(`[SHOP-DELETE] Shop ${shopId} (${shop.shop_name}) deleted by owner ${user.id}`)
  return NextResponse.json({ success: true })
}
