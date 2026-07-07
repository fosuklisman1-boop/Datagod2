import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  const { isAdmin, userId: adminId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { batchId } = await request.json()
    if (typeof batchId !== "string" || !/^[0-9a-f-]{36}$/i.test(batchId)) {
      return NextResponse.json({ error: "Invalid batchId" }, { status: 400 })
    }

    const now = new Date().toISOString()

    // Flip the batch first (guarded), so a wrong/already-registered id is a no-op.
    const { data: batchRows, error: batchErr } = await supabase
      .from("mtn_registration_batches")
      .update({ status: "registered", registered_at: now })
      .eq("id", batchId)
      .eq("status", "submitted")
      .select("id, number_count")
    if (batchErr) throw batchErr
    if (!batchRows || batchRows.length === 0) {
      return NextResponse.json({ error: "Batch not found or already registered" }, { status: 404 })
    }

    const { data: numRows, error: numErr } = await supabase
      .from("mtn_number_registry")
      .update({ status: "registered", registered_at: now, updated_at: now })
      .eq("submitted_batch", batchId)
      .eq("status", "submitted")
      .select("id")
    if (numErr) throw numErr

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
