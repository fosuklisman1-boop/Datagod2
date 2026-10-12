import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { notifyUserOfOutcome } from "@/lib/admin-actions"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function PATCH(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { complaintId, updates } = await request.json()

    if (!complaintId || !updates) {
      return NextResponse.json({ error: "Missing complaintId or updates" }, { status: 400 })
    }

    const allowedFields = ["status", "resolution_notes", "updated_at"]
    const sanitized: Record<string, any> = {}
    for (const key of allowedFields) {
      if (key in updates) sanitized[key] = updates[key]
    }

    if (Object.keys(sanitized).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 })
    }

    // Pre-image status so we only notify on a real status change.
    const { data: before } = await supabase.from("complaints").select("status").eq("id", complaintId).maybeSingle()
    const previousStatus: string | null = before?.status ?? null

    const { data, error } = await supabase
      .from("complaints")
      .update(sanitized)
      .eq("id", complaintId)
      .select(`*, user:user_id (id, email)`)

    if (error) {
      console.error("[ADMIN-COMPLAINTS] Update error:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!data || data.length === 0) {
      return NextResponse.json({ error: "Complaint not found" }, { status: 404 })
    }

    // Tell the complainant on a real transition to a terminal status only
    // (resolved -> "resolved", rejected -> "rejected"; pending never notifies).
    const row = data[0]
    const newStatus: string | undefined = sanitized.status
    if (newStatus && previousStatus !== newStatus && (newStatus === "resolved" || newStatus === "rejected") && row.user_id) {
      await notifyUserOfOutcome("complaint", newStatus, { userId: row.user_id, reference: complaintId }, {
        complaintId,
        orderId: row.order_id ?? undefined,
        resolutionNotes: row.resolution_notes ?? undefined,
      })
    }

    return NextResponse.json({ complaint: data[0] })
  } catch (error) {
    console.error("[ADMIN-COMPLAINTS] Unexpected error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
