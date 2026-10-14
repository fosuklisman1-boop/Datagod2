import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/rate-limiter"
import { isStorefrontOrderType, STOREFRONT_ORDER_TABLE, storefrontMomoStatus } from "@/lib/storefront-commission/payment"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * GET /api/payments/momo-status?orderId=...&orderType=data|airtime|results_checker|cs_bill|cs_bundle[&reference=...]
 *
 * Polled by the live "approve the prompt" modal during a direct MoMo charge.
 * Returns the order's current payment_status. The charge.success webhook flips
 * it to "completed" once the customer approves the prompt with their PIN.
 *
 *   { status: "pending" | "completed" | "failed" }
 */
export async function GET(request: NextRequest) {
  // Light rate limit — the client polls every few seconds.
  const rl = await applyRateLimit(request, "momo_status", 60, 60_000)
  if (!rl.allowed) {
    return NextResponse.json({ status: "pending" }, { status: 429 })
  }

  const { searchParams } = new URL(request.url)
  const orderId = searchParams.get("orderId")
  const orderType = searchParams.get("orderType") || "data"
  const reference = searchParams.get("reference")

  // Order-free flows (wallet top-up, dealer upgrade) have no order row — their
  // state lives on the wallet_payments record, keyed by the Paystack reference.
  if (!orderId && reference) {
    try {
      const { data } = await supabase
        .from("wallet_payments")
        .select("status")
        .eq("reference", reference)
        .maybeSingle()

      const ps = (data as any)?.status
      let status: "pending" | "completed" | "failed" = "pending"
      if (ps === "completed" || ps === "success") status = "completed"
      else if (ps === "failed" || ps === "abandoned" || ps === "cancelled") status = "failed"

      return NextResponse.json({ status }, { headers: { "Cache-Control": "no-store" } })
    } catch {
      return NextResponse.json({ status: "pending" })
    }
  }

  if (!orderId) {
    return NextResponse.json({ error: "orderId or reference required" }, { status: 400 })
  }

  // Storefront bill / bundle orders (cs_bill / cs_bundle): paid flip on the order; a failed charge is recorded on the
  // wallet_payments row of THIS order's reference only (the order itself stays payable).
  if (isStorefrontOrderType(orderType)) {
    try {
      const { data: order } = await supabase
        .from(STOREFRONT_ORDER_TABLE[orderType])
        .select("payment_status")
        .eq("id", orderId)
        .maybeSingle()
      let walletStatus: string | null = null
      if (reference && (order as any)?.payment_status === "unpaid") {
        const { data: wp } = await supabase
          .from("wallet_payments")
          .select("status")
          .eq("reference", reference)
          .eq("order_id", orderId)
          .maybeSingle()
        walletStatus = (wp as any)?.status ?? null
      }
      const status = storefrontMomoStatus((order as any)?.payment_status ?? null, walletStatus)
      return NextResponse.json({ status }, { headers: { "Cache-Control": "no-store" } })
    } catch {
      return NextResponse.json({ status: "pending" })
    }
  }

  const table = orderType === "airtime" ? "airtime_orders"
    : orderType === "results_checker" ? "results_checker_orders"
    : orderType === "results_check_service" ? "results_check_requests"
    : "shop_orders"

  try {
    // results_check_requests has no order_status column (that's shop_orders-only)
    // and uses payment_status: 'paid' (not 'completed') once payment is confirmed.
    const selectColumns = orderType === "results_check_service" ? "payment_status" : "payment_status, order_status"
    const { data } = await supabase
      .from(table)
      .select(selectColumns)
      .eq("id", orderId)
      .maybeSingle()

    const ps = (data as any)?.payment_status
    let status: "pending" | "completed" | "failed" = "pending"
    if (ps === "completed" || (orderType === "results_check_service" && ps === "paid")) status = "completed"
    else if (ps === "failed" || ps === "abandoned" || ps === "expired") status = "failed"

    return NextResponse.json(
      { status, order_status: (data as any)?.order_status ?? null },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch {
    return NextResponse.json({ status: "pending" })
  }
}
