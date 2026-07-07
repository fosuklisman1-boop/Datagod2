import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import * as XLSX from "xlsx"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { buildMtnRegistrationRows, parseClaimResult } from "@/lib/mtn-registration"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  const { isAdmin, userId: adminId, userEmail: adminEmail, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    // Atomic claim: flips ALL pending -> submitted and records the batch in
    // one DB transaction (race-safe across concurrent admins).
    const { data, error } = await supabase.rpc("claim_mtn_registration_batch", {
      p_admin_id: adminId ?? null,
      p_admin_email: adminEmail ?? null,
    })
    if (error) {
      console.error("[MTN-REG-EXPORT] claim rpc error:", error)
      return NextResponse.json({ error: "Failed to claim new numbers" }, { status: 500 })
    }

    const claim = parseClaimResult(data)

    const workbook = XLSX.utils.book_new()
    const rows = buildMtnRegistrationRows(claim.phones)
    const ws = rows.length
      ? XLSX.utils.json_to_sheet(rows)
      : XLSX.utils.json_to_sheet([], { header: ["Phone"] })
    XLSX.utils.book_append_sheet(workbook, ws, "MTN Numbers")

    // Audit trail: bulk PII export. Awaited so the record is durably written
    // before the serverless function freezes; best-effort (never fails the download).
    if (claim.count > 0) {
      try {
        const { error: auditErr } = await supabase
          .from("admin_audit_log")
          .insert([{
            admin_id: adminId || null,
            action: "export_mtn_registration",
            new_value: { batch_id: claim.batchId, number_count: claim.count },
            created_at: new Date().toISOString(),
          }])
        if (auditErr) console.warn("[MTN-REG-EXPORT] audit insert failed:", auditErr.message)
      } catch (auditErr) {
        console.warn("[MTN-REG-EXPORT] audit insert threw:", auditErr)
      }
    }

    const excelBuffer = XLSX.write(workbook, { bookType: "xlsx", type: "array" })
    const fileName = `mtn-register-${new Date().toISOString().split("T")[0]}.xlsx`
    return new NextResponse(excelBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
        "X-New-Count": String(claim.count),
      },
    })
  } catch (error) {
    console.error("[MTN-REG-EXPORT] Internal Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
