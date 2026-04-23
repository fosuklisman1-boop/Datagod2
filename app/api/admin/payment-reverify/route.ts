import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || ""
const PAYSTACK_BASE_URL = "https://api.paystack.co"
const BULK_LIMIT = 20

async function verifyWithPaystack(reference: string): Promise<{
  status: "success" | "failed" | "pending" | "abandoned"
  amount?: number
  message?: string
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
      return { status: "abandoned", message: data.message || "Transaction not found" }
    }
    if (!data?.data) {
      return { status: "abandoned", message: "No data returned from Paystack" }
    }

    return {
      status: data.data?.status || "pending",
      amount: data.data?.amount ? data.data.amount / 100 : 0,
    }
  } catch (error) {
    console.error("[REVERIFY] Paystack API error:", error)
    return { status: "pending", message: String(error) }
  }
}

/**
 * GET /api/admin/payment-reverify
 * List all shop_orders and airtime_orders with payment_status = 'pending'
 */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const { searchParams } = new URL(request.url)
  const orderType = searchParams.get("orderType") || "all"
  const search = (searchParams.get("search") || "").slice(0, 100)
  const startDate = searchParams.get("startDate") || ""
  const endDate = searchParams.get("endDate") || ""
  const page = Math.max(parseInt(searchParams.get("page") || "1") || 1, 1)
  const limit = Math.min(parseInt(searchParams.get("limit") || "50") || 50, 100)
  const offset = (page - 1) * limit

  let dataOrders: any[] = []
  let airtimeOrders: any[] = []
  let dataCount = 0
  let airtimeCount = 0

  // For single-type filters we can paginate at the DB level.
  // For "all" we fetch a bounded window from each table and merge in-memory,
  // capped at (offset + limit) rows per table so we never load unbounded data.
  const fetchCap = offset + limit

  if (orderType === "all" || orderType === "data") {
    let q = supabase
      .from("shop_orders")
      .select(
        "id, reference_code, customer_phone, customer_name, network, total_price, order_status, payment_status, created_at",
        { count: "exact" }
      )
      .eq("payment_status", "pending")
      .not("reference_code", "is", null)

    if (search) q = q.or(`reference_code.ilike.%${search}%,customer_phone.ilike.%${search}%,customer_name.ilike.%${search}%`)
    if (startDate) q = q.gte("created_at", startDate)
    if (endDate) {
      const end = new Date(endDate)
      end.setDate(end.getDate() + 1)
      q = q.lt("created_at", end.toISOString())
    }

    q = q.order("created_at", { ascending: true })
    // Single-type: precise DB-level pagination. Mixed: bounded cap for in-memory merge.
    if (orderType === "data") {
      q = q.range(offset, offset + limit - 1)
    } else {
      q = q.limit(fetchCap)
    }

    const { data, count } = await q
    dataOrders = (data || []).map((o) => ({
      ...o,
      order_type: "data",
      amount: o.total_price,
    }))
    dataCount = count || 0
  }

  if (orderType === "all" || orderType === "airtime") {
    let q = supabase
      .from("airtime_orders")
      .select(
        "id, reference_code, beneficiary_phone, network, total_paid, status, payment_status, created_at",
        { count: "exact" }
      )
      .eq("payment_status", "pending")
      .not("reference_code", "is", null)

    if (search) q = q.or(`reference_code.ilike.%${search}%,beneficiary_phone.ilike.%${search}%`)
    if (startDate) q = q.gte("created_at", startDate)
    if (endDate) {
      const end = new Date(endDate)
      end.setDate(end.getDate() + 1)
      q = q.lt("created_at", end.toISOString())
    }

    q = q.order("created_at", { ascending: true })
    if (orderType === "airtime") {
      q = q.range(offset, offset + limit - 1)
    } else {
      q = q.limit(fetchCap)
    }

    const { data, count } = await q
    airtimeOrders = (data || []).map((o) => ({
      ...o,
      order_type: "airtime",
      customer_phone: o.beneficiary_phone,
      amount: o.total_paid,
    }))
    airtimeCount = count || 0
  }

  const allOrders = [...dataOrders, ...airtimeOrders]
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(offset, offset + limit)

  const totalCount = dataCount + airtimeCount

  // Find oldest pending order
  const oldest = allOrders[0]?.created_at || null

  return NextResponse.json({
    orders: allOrders,
    stats: {
      total: totalCount,
      dataOrders: dataCount,
      airtimeOrders: airtimeCount,
      oldestPending: oldest,
    },
    pagination: {
      page,
      limit,
      totalCount,
      totalPages: Math.ceil(totalCount / limit),
    },
  })
}

/**
 * POST /api/admin/payment-reverify
 * Verify one or many pending orders against Paystack and process them.
 * Body (single): { orderId, orderType: 'data'|'airtime', reference }
 * Body (bulk):   { bulk: true, bulkType?: 'data'|'airtime'|'all' }
 */
export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const body = await request.json()
  const { orderId, orderType, bulk, bulkType } = body

  type OrderRow = {
    id: string
    order_type: "data" | "airtime"
    reference_code: string
    network?: string
    customer_phone?: string
    volume_gb?: number
    customer_name?: string
    shop_id?: string
    profit_amount?: number
    parent_shop_id?: string
    parent_profit_amount?: number
    merchant_commission?: number
  }

  let orders: OrderRow[] = []

  if (bulk) {
    const types: string[] =
      bulkType === "data" ? ["data"] : bulkType === "airtime" ? ["airtime"] : ["data", "airtime"]

    if (types.includes("data")) {
      const { data } = await supabase
        .from("shop_orders")
        .select("id, reference_code, network, customer_phone, volume_gb, customer_name, shop_id, profit_amount, parent_shop_id, parent_profit_amount")
        .eq("payment_status", "pending")
        .not("reference_code", "is", null)
        .order("created_at", { ascending: true })
        .limit(BULK_LIMIT)
      if (data) orders.push(...data.map((o) => ({ ...o, order_type: "data" as const })))
    }

    if (types.includes("airtime")) {
      const { data } = await supabase
        .from("airtime_orders")
        .select("id, reference_code, network, beneficiary_phone, merchant_commission, shop_id")
        .eq("payment_status", "pending")
        .not("reference_code", "is", null)
        .order("created_at", { ascending: true })
        .limit(BULK_LIMIT)
      if (data)
        orders.push(
          ...data.map((o) => ({
            ...o,
            order_type: "airtime" as const,
            customer_phone: o.beneficiary_phone,
          }))
        )
    }
  } else {
    if (!orderId || !orderType) {
      return NextResponse.json(
        { error: "orderId and orderType are required" },
        { status: 400 }
      )
    }

    if (orderType === "data") {
      const { data } = await supabase
        .from("shop_orders")
        .select("id, reference_code, network, customer_phone, volume_gb, customer_name, shop_id, profit_amount, parent_shop_id, parent_profit_amount")
        .eq("id", orderId)
        .single()
      if (data) orders = [{ ...data, order_type: "data" }]
    } else {
      const { data } = await supabase
        .from("airtime_orders")
        .select("id, reference_code, network, beneficiary_phone, merchant_commission, shop_id")
        .eq("id", orderId)
        .single()
      if (data) orders = [{ ...data, order_type: "airtime", customer_phone: data.beneficiary_phone }]
    }
  }

  if (orders.length === 0) {
    return NextResponse.json({ error: "No matching pending orders found" }, { status: 404 })
  }

  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000")

  const results: Array<{
    id: string
    reference: string
    order_type: string
    paystack_status: string
    action: string
    fulfillment?: string
  }> = []

  let verified = 0
  let failed = 0
  let stillPending = 0
  let fulfilled = 0

  for (const order of orders) {
    try {
      const paystack = await verifyWithPaystack(order.reference_code)

      if (paystack.status === "success") {
        if (order.order_type === "data") {
          // Idempotency: skip if already processed
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
            results.push({ id: order.id, reference: order.reference_code, order_type: order.order_type, paystack_status: "success", action: "already_processed" })
            continue
          }

          // Check fulfillment tracking (prevents double-fulfillment)
          const { data: existingTracking } = await supabase
            .from("mtn_fulfillment_tracking")
            .select("id, status")
            .eq("shop_order_id", order.id)
            .maybeSingle()

          await supabase
            .from("shop_orders")
            .update({ payment_status: "completed", updated_at: new Date().toISOString() })
            .eq("id", order.id)

          // Profit records — 23505 means already credited, any other error is real
          if (order.profit_amount && order.profit_amount > 0 && order.shop_id) {
            const { error: profitErr } = await supabase.from("shop_profits").insert([{
              shop_id: order.shop_id,
              shop_order_id: order.id,
              profit_amount: order.profit_amount,
              status: "credited",
              created_at: new Date().toISOString(),
            }])
            if (profitErr && profitErr.code !== "23505") {
              console.error(`[REVERIFY] Failed to insert shop profit for order ${order.id}:`, profitErr)
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
              console.error(`[REVERIFY] Failed to insert parent shop profit for order ${order.id}:`, parentProfitErr)
            }
          }

          let fulfillmentStatus = "skipped (tracking exists)"
          if (!existingTracking) {
            try {
              // Normalize volume_gb — stored values may be strings like "5GB"
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
              if (res.ok && res_data.success) {
                fulfillmentStatus = "triggered"
                fulfilled++
              } else {
                fulfillmentStatus = res_data.error || "failed"
              }
            } catch {
              fulfillmentStatus = "error"
            }
          }

          verified++
          results.push({
            id: order.id,
            reference: order.reference_code,
            order_type: order.order_type,
            paystack_status: "success",
            action: "verified",
            fulfillment: fulfillmentStatus,
          })
        } else {
          // Airtime order idempotency check
          const { data: current } = await supabase
            .from("airtime_orders")
            .select("payment_status")
            .eq("id", order.id)
            .single()

          if (current?.payment_status === "completed") {
            results.push({ id: order.id, reference: order.reference_code, order_type: order.order_type, paystack_status: "success", action: "already_processed" })
            continue
          }

          await supabase
            .from("airtime_orders")
            .update({ payment_status: "completed", status: "pending", updated_at: new Date().toISOString() })
            .eq("id", order.id)

          if (order.merchant_commission && order.merchant_commission > 0 && order.shop_id) {
            const { error: airtimeProfitErr } = await supabase.from("shop_profits").insert([{
              shop_id: order.shop_id,
              airtime_order_id: order.id,
              profit_amount: order.merchant_commission,
              status: "credited",
              created_at: new Date().toISOString(),
            }])
            if (airtimeProfitErr && airtimeProfitErr.code !== "23505") {
              console.error(`[REVERIFY] Failed to insert airtime profit for order ${order.id}:`, airtimeProfitErr)
            }
          }

          verified++
          results.push({
            id: order.id,
            reference: order.reference_code,
            order_type: order.order_type,
            paystack_status: "success",
            action: "verified",
          })
        }
      } else if (paystack.status === "failed") {
        const table = order.order_type === "data" ? "shop_orders" : "airtime_orders"
        await supabase
          .from(table)
          .update({ payment_status: "failed", updated_at: new Date().toISOString() })
          .eq("id", order.id)
        failed++
        results.push({ id: order.id, reference: order.reference_code, order_type: order.order_type, paystack_status: "failed", action: "marked_failed" })
      } else if (paystack.status === "abandoned") {
        const table = order.order_type === "data" ? "shop_orders" : "airtime_orders"
        await supabase
          .from(table)
          .update({ payment_status: "abandoned", updated_at: new Date().toISOString() })
          .eq("id", order.id)
        failed++
        results.push({ id: order.id, reference: order.reference_code, order_type: order.order_type, paystack_status: "abandoned", action: "marked_abandoned" })
      } else {
        stillPending++
        results.push({ id: order.id, reference: order.reference_code, order_type: order.order_type, paystack_status: "pending", action: "still_pending" })
      }
    } catch (err) {
      console.error(`[REVERIFY] Error processing order ${order.id}:`, err)
      results.push({ id: order.id, reference: order.reference_code, order_type: order.order_type, paystack_status: "error", action: String(err) })
      failed++
    }

    // Respect Paystack rate limits
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  console.log(`[REVERIFY] Complete — verified: ${verified}, fulfilled: ${fulfilled}, failed: ${failed}, stillPending: ${stillPending}`)

  return NextResponse.json({
    success: true,
    total: orders.length,
    verified,
    fulfilled,
    failed,
    stillPending,
    results,
  })
}
