import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * POST /api/admin/backfill/airtime-payments
 *
 * Fixes airtime orders stuck in payment_status='pending' due to
 * the race condition on the confirmation page.
 * Cross-references wallet_payments to only fix orders Paystack confirmed.
 */
export async function POST(request: NextRequest) {
  // Admin auth check
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const token = authHeader.substring(7)
  const { data: { user }, error: userError } = await supabase.auth.getUser(token)
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const isAdmin = user.user_metadata?.role === "admin"
  if (!isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  try {
    console.log("[BACKFILL] Starting airtime payment status backfill...")

    // STEP 1: Find affected orders
    const { data: affectedOrders, error: findError } = await supabase
      .from("airtime_orders")
      .select(`
        id, payment_status, status, merchant_commission,
        shop_id, beneficiary_phone, airtime_amount, network, reference_code,
        wallet_payments!inner(reference, status, order_type)
      `)
      .eq("wallet_payments.status", "completed")
      .eq("wallet_payments.order_type", "airtime")
      .not("payment_status", "in", '("completed","failed")')

    if (findError) {
      console.error("[BACKFILL] Error finding affected orders:", findError)
      return NextResponse.json({ error: findError.message }, { status: 500 })
    }

    const orderIds = (affectedOrders || []).map((o: any) => o.id)
    console.log(`[BACKFILL] Found ${orderIds.length} affected airtime orders`)

    if (orderIds.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No affected orders found — everything looks good!",
        fixed: 0,
      })
    }

    // STEP 2: Update payment_status to completed for all affected orders
    const { data: updated, error: updateError } = await supabase
      .from("airtime_orders")
      .update({
        payment_status: "completed",
        updated_at: new Date().toISOString(),
      })
      .in("id", orderIds)
      .not("payment_status", "in", '("completed","failed")')
      .select("id, status, merchant_commission, shop_id")

    if (updateError) {
      console.error("[BACKFILL] Update error:", updateError)
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }

    console.log(`[BACKFILL] Updated ${updated?.length || 0} orders to payment_status=completed`)

    // STEP 3: Create missing shop profit records
    let profitsCreated = 0
    for (const order of (updated || [])) {
      if (order.merchant_commission > 0 && order.shop_id) {
        const { error: profitError } = await supabase
          .from("shop_profits")
          .insert([{
            shop_id: order.shop_id,
            airtime_order_id: order.id,
            profit_amount: order.merchant_commission,
            status: "credited",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }])

        if (!profitError || profitError.code === "23505") {
          // 23505 = unique constraint (already exists), that's fine
          if (!profitError) profitsCreated++
        } else {
          console.error(`[BACKFILL] Profit insert error for order ${order.id}:`, profitError)
        }
      }
    }

    console.log(`[BACKFILL] Created ${profitsCreated} missing profit records`)

    return NextResponse.json({
      success: true,
      message: `Backfill complete. Fixed ${updated?.length || 0} airtime orders, created ${profitsCreated} missing profit records.`,
      fixed: updated?.length || 0,
      profits_created: profitsCreated,
      order_ids: updated?.map((o: any) => o.id) || [],
    })
  } catch (err: any) {
    console.error("[BACKFILL] Unexpected error:", err)
    return NextResponse.json(
      { error: err.message || "Internal server error" },
      { status: 500 }
    )
  }
}

/**
 * GET /api/admin/backfill/airtime-payments
 * Preview — shows affected orders without fixing them
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const token = authHeader.substring(7)
  const { data: { user }, error: userError } = await supabase.auth.getUser(token)
  if (userError || !user || user.user_metadata?.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  const { data: affectedOrders, error } = await supabase
    .from("airtime_orders")
    .select(`
      id, payment_status, status, beneficiary_phone, airtime_amount, network, created_at,
      wallet_payments!inner(reference, status, order_type)
    `)
    .eq("wallet_payments.status", "completed")
    .eq("wallet_payments.order_type", "airtime")
    .not("payment_status", "in", '("completed","failed")')
    .order("created_at", { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    count: (affectedOrders || []).length,
    affected_orders: affectedOrders || [],
  })
}
