import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { parseEnqueueBody, runEnqueue } from "@/lib/order-queue/enqueue"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * POST /api/admin/fulfillment/enqueue
 * Body: { orders: {id, type}[] (1..200), provider?: string, riskyAck?: { count } }
 * Every order is re-read and judged on the server (lib/order-queue/enqueue.ts); only eligible orders
 * (and held/reversed ones behind a matching riskyAck, explicit supplier only) are queued. No provider =
 * legacy auto routing, which never releases held/reversed orders.
 * 200 { batchId, queued: string[], rejected: {id, reason}[], risky: string[] }
 * 400 { error } for a bad request, { error: "risky_ack_mismatch", expected }, or
 *     { error: "risky_requires_supplier" } for a riskyAck without a provider (nothing written).
 * The drain cron (/api/cron/drain-fulfillment-queue) processes queued rows every minute.
 */
export async function POST(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin || errorResponse) return errorResponse ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  // Bulk sends must be attributable to a person (admin_bulk_send_log.admin_id); the cron-secret bypass has no user.
  if (!userId) return NextResponse.json({ error: "An admin user is required" }, { status: 403 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 })
  }
  const parsed = parseEnqueueBody(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  try {
    const result = await runEnqueue(supabase, parsed.value, userId)
    return NextResponse.json(result.body, { status: result.status })
  } catch (err) {
    // Only the snapshot reads throw (writes report errors per order), so in practice nothing was written.
    console.error("[ENQUEUE] failed:", err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: "Could not check the orders. Check the queue before retrying." }, { status: 500 })
  }
}
