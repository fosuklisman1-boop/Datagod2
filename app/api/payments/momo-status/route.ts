import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/rate-limiter"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * GET /api/payments/momo-status?orderId=...&orderType=data|airtime|results_checker
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
  if (!orderId) {
    return NextResponse.json({ error: "orderId required" }, { status: 400 })
  }

  const table = orderType === "airtime" ? "airtime_orders"
    : orderType === "results_checker" ? "results_checker_orders"
    : "shop_orders"

  try {
    const { data } = await supabase
      .from(table)
      .select("payment_status, order_status")
      .eq("id", orderId)
      .maybeSingle()

    const ps = (data as any)?.payment_status
    let status: "pending" | "completed" | "failed" = "pending"
    if (ps === "completed") status = "completed"
    else if (ps === "failed" || ps === "abandoned" || ps === "expired") status = "failed"

    return NextResponse.json(
      { status, order_status: (data as any)?.order_status ?? null },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch {
    return NextResponse.json({ status: "pending" })
  }
}
