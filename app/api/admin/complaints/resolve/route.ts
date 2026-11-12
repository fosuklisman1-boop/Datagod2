import { NextRequest, NextResponse } from "next/server"
import { getSupportDb, requireSupportAdmin } from "@/lib/support-auth"
import { resolveComplaintSchema } from "@/lib/support-validation"
import { notifyUserOfOutcome } from "@/lib/admin-actions"
import { runAfterResponse } from "@/lib/support-notify"

export const dynamic = "force-dynamic"

const fail = (error: string, status: number) => NextResponse.json({ success: false, error }, { status })

export async function POST(request: NextRequest) {
  const auth = await requireSupportAdmin(request)
  if ("response" in auth) return auth.response

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return fail("Invalid request body.", 400)
  }
  const parsed = resolveComplaintSchema.safeParse(raw)
  if (!parsed.success) return fail("Choose resolved or rejected and keep the notes under 2000 characters.", 400)
  const { id, status, resolution_notes } = parsed.data

  try {
    const db = getSupportDb()
    const { data: row, error: loadError } = await db.from("complaints").select("id, user_id, order_id, status").eq("id", id).maybeSingle()
    if (loadError) throw new Error("complaint lookup failed")
    if (!row) return fail("Complaint not found.", 404)
    if (row.status === "resolved" || row.status === "rejected") return fail("This complaint is already resolved", 409)

    // Compare-and-swap: only an open row can be closed, so a concurrent resolve loses cleanly.
    const { data: updated, error: updateError } = await db
      .from("complaints")
      .update({ status, resolution_notes, updated_at: new Date().toISOString() })
      .eq("id", id)
      .in("status", ["pending", "in_review"])
      .select("id, user_id, order_id")
    if (updateError) throw new Error("complaint update failed")
    if (!updated || updated.length === 0) return fail("This complaint is already resolved", 409)

    const closed = updated[0] as { id: string; user_id: string; order_id: string | null }
    runAfterResponse(async () => {
      try {
        await notifyUserOfOutcome(
          "complaint",
          status,
          { userId: closed.user_id, reference: closed.id },
          { complaintId: closed.id, orderId: closed.order_id ?? undefined, resolutionNotes: resolution_notes || undefined },
        )
      } catch {
        console.error("[SUPPORT] complaint outcome notification failed", { complaintId: closed.id })
      }
    })
    return NextResponse.json({ success: true, data: { id: closed.id, status } })
  } catch {
    console.error("[SUPPORT] complaint resolve failed", { complaintId: id, adminId: auth.adminId })
    return fail("Something went wrong. Please try again.", 500)
  }
}
