import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { parseEnqueueBody, isKnownSupplier } from "@/lib/order-queue/enqueue"
import { previewApprovals } from "@/lib/order-queue/approval-preview"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * POST /api/admin/fulfillment/approval-preview
 * Body: { orders: {id, type}[] (1..200), supplier: string }
 * 200 { enabled, counts: { approved, notApproved, notChecked }, perOrder: { id, status }[] }
 * From SAVED supplier verdicts only: no supplier is called and no phone number is returned.
 * enabled false = the strict verification switch is off (nothing else is read).
 */
export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin || errorResponse) return errorResponse ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 })
  }
  const supplier = (body as { supplier?: unknown } | null)?.supplier
  if (typeof supplier !== "string" || !isKnownSupplier(supplier)) {
    return NextResponse.json({ error: "unknown supplier" }, { status: 400 })
  }
  // Same order-list validation as the send itself (uuid ids, <= 200, known types).
  const parsed = parseEnqueueBody({ orders: (body as { orders?: unknown }).orders })
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  try {
    return NextResponse.json(await previewApprovals(supabase, parsed.value.orders, supplier, new Date()))
  } catch (err) {
    console.error("[APPROVAL-PREVIEW] failed:", err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: "Could not load the approvals" }, { status: 500 })
  }
}
