import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || ""
const PAYSTACK_BASE_URL = "https://api.paystack.co"

async function verifyWithPaystack(reference: string): Promise<{
  status: "success" | "failed" | "pending" | "abandoned"
  amount?: number
}> {
  try {
    const response = await fetch(
      `${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    )
    const data = await response.json()

    if (
      response.status === 404 ||
      (typeof data?.message === "string" && data.message.toLowerCase().includes("not found"))
    ) {
      return { status: "abandoned" }
    }
    if (!data?.data) return { status: "abandoned" }

    return {
      status: data.data?.status || "pending",
      amount: data.data?.amount ? data.data.amount / 100 : 0,
    }
  } catch (error) {
    console.error("[SHOP-REVERIFY] Paystack API error:", error)
    return { status: "pending" }
  }
}

async function getWalletReferences(orderIds: string[]): Promise<Record<string, string>> {
  if (orderIds.length === 0) return {}

  const { data } = await supabase
    .from("wallet_payments")
    .select("order_id, reference, created_at")
    .in("order_id", orderIds)
    .order("created_at", { ascending: false })

  const map: Record<string, string> = {}
  for (const wp of data || []) {
    if (wp.order_id && !map[wp.order_id]) {
      map[wp.order_id] = wp.reference
    }
  }
  return map
}

async function resolveShop(request: NextRequest): Promise<{
  shopId: string | null
  errorResponse?: NextResponse
}> {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return { shopId: null, errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  }

  const token = authHeader.slice(7)
  const { data: userData, error: userError } = await supabase.auth.getUser(token)
  if (userError || !userData?.user?.id) {
    return { shopId: null, errorResponse: NextResponse.json({ error: "Invalid token" }, { status: 401 }) }
  }

  const { data: shop } = await supabase
    .from("user_shops")
    .select("id")
    .eq("user_id", userData.user.id)
    .single()

  if (!shop?.id) {
    return { shopId: null, errorResponse: NextResponse.json({ error: "No shop found for this account" }, { status: 403 }) }
  }

  return { shopId: shop.id }
}

/**
 * GET /api/shop/payment-reverify
 * List pending shop_orders for the authenticated shop owner.
 */
export async function GET(request: NextRequest) {
  const { shopId, errorResponse } = await resolveShop(request)
  if (!shopId) return errorResponse!

  const { searchParams } = new URL(request.url)
  const search = (searchParams.get("search") || "").slice(0, 100)
  const page = Math.max(parseInt(searchParams.get("page") || "1") || 1, 1)
  const limit = Math.min(parseInt(searchParams.get("limit") || "20") || 20, 20)
  const offset = (page - 1) * limit

  let q = supabase
    .from("shop_orders")
    .select(
      "id, reference_code, customer_phone, customer_name, network, total_price, order_status, payment_status, created_at",
      { count: "exact" }
    )
    .eq("shop_id", shopId)
    .eq("payment_status", "pending")

  if (search) {
    q = q.or(`reference_code.ilike.%${search}%,customer_phone.ilike.%${search}%,customer_name.ilike.%${search}%`)
  }

  const { data, count, error } = await q
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) {
    console.error("[SHOP-REVERIFY] Error fetching orders:", error)
    return NextResponse.json({ error: "Failed to fetch orders" }, { status: 500 })
  }

  const orders = data || []
  const walletRefMap = await getWalletReferences(orders.map((o) => o.id))

  const filteredOrders = orders
    .filter((o) => walletRefMap[o.id])
    .map((o) => ({ ...o, wallet_reference: walletRefMap[o.id] }))

  const totalCount = count || 0

  return NextResponse.json({
    orders: filteredOrders,
    pagination: {
      page,
      limit,
      totalCount,
      totalPages: Math.ceil(totalCount / limit),
    },
  })
}

/**
 * POST /api/shop/payment-reverify
 * Reverify a single pending order for the authenticated shop owner.
 * Body: { orderId }
 */
export async function POST(request: NextRequest) {
  const { shopId, errorResponse } = await resolveShop(request)
  if (!shopId) return errorResponse!

  const body = await request.json()
  const { orderId } = body

  if (!orderId) {
    return NextResponse.json({ error: "orderId is required" }, { status: 400 })
  }

  // Fetch order — the shop_id check prevents cross-shop access
  const { data: order, error: orderError } = await supabase
    .from("shop_orders")
    .select("id, reference_code, network, customer_phone, volume_gb, customer_name, shop_id, profit_amount, parent_shop_id, parent_profit_amount, payment_status, order_status")
    .eq("id", orderId)
    .eq("shop_id", shopId)
    .single()

  if (orderError || !order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 })
  }

  // Resolve WALLET- reference
  const walletRefMap = await getWalletReferences([order.id])
  const walletReference = walletRefMap[order.id]

  if (!walletReference) {
    return NextResponse.json({
      paystack_status: "unknown",
      action: "no_payment_reference",
    })
  }

  // Verify with Paystack
  const paystack = await verifyWithPaystack(walletReference)

  if (paystack.status === "success") {
    // Idempotency: re-fetch to catch concurrent updates
    const { data: current } = await supabase
      .from("shop_orders")
      .select("payment_status, order_status")
      .eq("id", order.id)
      .single()

    if (
      current?.payment_status === "completed" ||
      current?.order_status === "processing" ||
      current?.order_status === "completed"
    ) {
      return NextResponse.json({ paystack_status: "success", action: "already_processed" })
    }

    // Check fulfillment tracking to prevent double-fulfillment
    const { data: existingTracking } = await supabase
      .from("mtn_fulfillment_tracking")
      .select("id, status")
      .eq("shop_order_id", order.id)
      .maybeSingle()

    await supabase
      .from("shop_orders")
      .update({ payment_status: "completed", updated_at: new Date().toISOString() })
      .eq("id", order.id)

    // Profit records — 23505 = already credited
    if (order.profit_amount && order.profit_amount > 0 && order.shop_id) {
      const { error: profitErr } = await supabase.from("shop_profits").insert([{
        shop_id: order.shop_id,
        shop_order_id: order.id,
        profit_amount: order.profit_amount,
        status: "credited",
        created_at: new Date().toISOString(),
      }])
      if (profitErr && profitErr.code !== "23505") {
        console.error(`[SHOP-REVERIFY] Failed to insert shop profit for ${order.id}:`, profitErr)
      }
    }
    if (order.parent_shop_id && order.parent_profit_amount && order.parent_profit_amount > 0) {
      const { error: parentProfitErr } = await supabase.from("shop_profits").insert([{
        shop_id: order.parent_shop_id,
        shop_order_id: order.id,
        profit_amount: order.parent_profit_amount,
        status: "credited",
        created_at: new Date().toISOString(),
      }])
      if (parentProfitErr && parentProfitErr.code !== "23505") {
        console.error(`[SHOP-REVERIFY] Failed to insert parent profit for ${order.id}:`, parentProfitErr)
      }
    }

    let fulfillmentStatus = "skipped (tracking exists)"
    if (!existingTracking) {
      try {
        const baseUrl =
          process.env.NEXT_PUBLIC_APP_URL ||
          (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000")

        const volumeGb = parseInt(
          String(order.volume_gb ?? "0").replace(/[^0-9]/g, "") || "0"
        )
        const res = await fetch(`${baseUrl}/api/fulfillment/process-order`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            shop_order_id: order.id,
            network: order.network,
            phone_number: order.customer_phone,
            volume_gb: volumeGb,
            customer_name: order.customer_name || "Customer",
          }),
        })
        const res_data = await res.json()
        fulfillmentStatus = res.ok && res_data.success ? "triggered" : (res_data.error || "failed")
      } catch {
        fulfillmentStatus = "error"
      }
    }

    return NextResponse.json({
      paystack_status: "success",
      action: "verified",
      fulfillment: fulfillmentStatus,
    })
  }

  if (paystack.status === "failed") {
    await supabase
      .from("shop_orders")
      .update({ payment_status: "failed", updated_at: new Date().toISOString() })
      .eq("id", order.id)
    return NextResponse.json({ paystack_status: "failed", action: "marked_failed" })
  }

  if (paystack.status === "abandoned") {
    await supabase
      .from("shop_orders")
      .update({ payment_status: "abandoned", updated_at: new Date().toISOString() })
      .eq("id", order.id)
    return NextResponse.json({ paystack_status: "abandoned", action: "marked_abandoned" })
  }

  return NextResponse.json({ paystack_status: "pending", action: "still_pending" })
}
