import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

export const dynamic = "force-dynamic"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  const { isAdmin, userId: adminId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { batchId } = await request.json()
    if (typeof batchId !== "string" || !UUID_RE.test(batchId)) {
      return NextResponse.json({ error: "Invalid batchId" }, { status: 400 })
    }

    const now = new Date().toISOString()

    // Confirm the batch exists first (bogus ids -> 404 without touching the registry).
    const { data: batch, error: batchFetchErr } = await supabase
      .from("mtn_registration_batches")
      .select("id, status")
      .eq("id", batchId)
      .single()
    if (batchFetchErr || !batch) {
      return NextResponse.json({ error: "Batch not found" }, { status: 404 })
    }

    // Numbers FIRST, batch LAST — if anything fails in between, the batch stays
    // 'submitted' and a retry converges (numbers already flipped -> 0 rows, then
    // the batch completes). The reverse order strands numbers un-registered.
    const { data: numRows, error: numErr } = await supabase
      .from("mtn_number_registry")
      .update({ status: "registered", registered_at: now, updated_at: now })
      .eq("submitted_batch", batchId)
      .eq("status", "submitted")
      .select("id")
    if (numErr) throw numErr

    const { error: batchErr } = await supabase
      .from("mtn_registration_batches")
      .update({ status: "registered", registered_at: now })
      .eq("id", batchId)
      .eq("status", "submitted")
    if (batchErr) throw batchErr

    // Audit: registration state change (awaited, best-effort).
    try {
      const { error: auditErr } = await supabase
        .from("admin_audit_log")
        .insert([{
          admin_id: adminId || null,
          action: "mtn_registration_mark_registered",
          new_value: { batch_id: batchId, numbers_registered: numRows?.length ?? 0 },
          created_at: now,
        }])
      if (auditErr) console.warn("[MTN-REG-MARK] audit insert failed:", auditErr.message)
    } catch (auditErr) {
      console.warn("[MTN-REG-MARK] audit insert threw:", auditErr)
    }

    return NextResponse.json({ ok: true, numbersRegistered: numRows?.length ?? 0 })
  } catch (error) {
    console.error("[MTN-REG-MARK] error:", error)
    return NextResponse.json({ error: "Failed to mark batch registered" }, { status: 500 })
  }
}
