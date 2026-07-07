import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import * as XLSX from "xlsx"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { buildMtnRegistrationRows } from "@/lib/mtn-registration"

export const dynamic = "force-dynamic"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { id } = await params
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: "Invalid batch id" }, { status: 400 })
    }

    const { data: batch, error } = await supabase
      .from("mtn_registration_batches")
      .select("id, batch_time, phones, number_count")
      .eq("id", id)
      .single()
    if (error || !batch) {
      return NextResponse.json({ error: "Batch not found" }, { status: 404 })
    }

    const phones: string[] = Array.isArray(batch.phones) ? batch.phones.map(String) : []
    const workbook = XLSX.utils.book_new()
    const rows = buildMtnRegistrationRows(phones)
    const ws = rows.length
      ? XLSX.utils.json_to_sheet(rows)
      : XLSX.utils.json_to_sheet([], { header: ["Phone"] })
    XLSX.utils.book_append_sheet(workbook, ws, "MTN Numbers")

    const excelBuffer = XLSX.write(workbook, { bookType: "xlsx", type: "array" })
    const day = String(batch.batch_time).split("T")[0]
    return new NextResponse(excelBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="mtn-register-batch-${day}.xlsx"`,
        "Cache-Control": "no-store",
      },
    })
  } catch (error) {
    console.error("[MTN-REG-BATCH-DL] error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
