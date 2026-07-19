import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * GET /api/admin/fulfillment/queue-status?batchId=<uuid>
 * Returns live counts per status for a fulfillment batch.
 */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const batchId = request.nextUrl.searchParams.get("batchId")
  if (!batchId) return NextResponse.json({ error: "batchId is required" }, { status: 400 })

  const { data, error } = await supabase
    .from("fulfillment_queue")
    .select("status")
    .eq("batch_id", batchId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const counts = { total: 0, pending: 0, processing: 0, completed: 0, failed: 0 }
  for (const row of data ?? []) {
    counts.total++
    counts[row.status as keyof typeof counts]++
  }

  return NextResponse.json(counts)
}
