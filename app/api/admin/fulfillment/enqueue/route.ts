import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * POST /api/admin/fulfillment/enqueue
 * Inserts a batch of orders into fulfillment_queue and returns immediately.
 * The drain cron (/api/cron/drain-fulfillment-queue) processes them every minute.
 */
export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const body = await request.json()
  const { orders, provider } = body as {
    orders: { id: string; type: string }[]
    provider?: string
  }

  if (!Array.isArray(orders) || orders.length === 0) {
    return NextResponse.json({ error: "orders array is required" }, { status: 400 })
  }

  const batchId = crypto.randomUUID()
  const rows = orders.map(o => ({
    batch_id: batchId,
    order_id: o.id,
    order_type: o.type || "shop",
    provider: provider ?? null,
  }))

  const { error } = await supabase.from("fulfillment_queue").insert(rows)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ batchId, queued: rows.length })
}
