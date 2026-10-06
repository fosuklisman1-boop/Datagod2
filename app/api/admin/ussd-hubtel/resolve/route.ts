// app/api/admin/ussd-hubtel/resolve/route.ts
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { resolveNeedsReview, type ResolveOutcome } from "@/lib/ussd-hubtel/resolve"
import { createFailHandlers } from "@/lib/ussd-hubtel/order-handlers"
import { safeDbError } from "@/lib/ussd-hubtel/log-safe"

export async function POST(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!
  // admin_audit_log.admin_id is NOT NULL: a resolution must be attributable to a signed-in admin.
  if (!userId) return NextResponse.json({ error: "A signed-in admin is required" }, { status: 403 })

  const body = (await request.json().catch(() => ({}))) as { sessionId?: unknown; outcome?: unknown; note?: unknown }
  const valid =
    typeof body.sessionId === "string" && body.sessionId.length > 0 &&
    typeof body.note === "string" &&
    (body.outcome === "fulfilled" || body.outcome === "not_paid")
  if (!valid) {
    return NextResponse.json({ error: "sessionId, outcome (fulfilled | not_paid) and note are required" }, { status: 400 })
  }

  try {
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const result = await resolveNeedsReview({
      supabase,
      failHandlers: createFailHandlers(supabase),
      sessionId: body.sessionId as string,
      outcome: body.outcome as ResolveOutcome,
      note: body.note as string,
      adminId: userId,
    })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json(result)
  } catch (e) {
    console.error("[HUBTEL-ADMIN] resolve error:", safeDbError(e))
    return NextResponse.json({ error: "Failed to resolve" }, { status: 500 })
  }
}
