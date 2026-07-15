import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import * as XLSX from "xlsx"
import { verifyAdminAccess } from "@/lib/admin-auth"
import {
  groupPhonesByNetwork,
  toSheetRows,
  buildSummaryRows,
  NETWORK_SHEETS,
  type RawPhoneRow,
} from "@/lib/order-phone-network"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  const { isAdmin, userId: adminId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { data, error } = await supabase.rpc("get_all_order_phones")
    if (error) {
      console.error("[PHONE-EXPORT] rpc error:", error)
      return NextResponse.json({ error: "Failed to gather order phones" }, { status: 500 })
    }

    const rows = (data ?? []) as RawPhoneRow[]
    const grouped = groupPhonesByNetwork(rows)
    const summary = buildSummaryRows(grouped)

    // Build workbook: Summary first, then one sheet per network (always present).
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(summary),
      "Summary"
    )
    for (const sheet of NETWORK_SHEETS) {
      const sheetRows = toSheetRows(grouped.get(sheet) ?? [])
      // json_to_sheet on [] yields an empty sheet; add a header row explicitly.
      const ws = sheetRows.length
        ? XLSX.utils.json_to_sheet(sheetRows)
        : XLSX.utils.json_to_sheet([], {
            header: ["Phone", "Orders", "First Order", "Last Order", "Products"],
          })
      // Sheet names cannot exceed 31 chars or contain []:*?/\ — ours are safe.
      XLSX.utils.book_append_sheet(workbook, ws, sheet)
    }

    const totals = summary.find(s => s.Network === "TOTAL")
    // Audit trail: bulk PII export. AWAIT it (not fire-and-forget) so the record
    // is durably written before this serverless function freezes on response.
    // Best-effort: a failed audit insert must not fail the download.
    try {
      const { error: auditErr } = await supabase
        .from("admin_audit_log")
        .insert([{
          admin_id: adminId || null,
          action: "export_all_order_phones",
          new_value: {
            total_unique_phones: totals?.["Unique Phones"] ?? 0,
            total_orders: totals?.["Total Orders"] ?? 0,
            by_network: summary.filter(s => s.Network !== "TOTAL"),
          },
          created_at: new Date().toISOString(),
        }])
      if (auditErr) console.warn("[PHONE-EXPORT] audit insert failed:", auditErr.message)
    } catch (auditErr) {
      console.warn("[PHONE-EXPORT] audit insert threw:", auditErr)
    }

    const excelBuffer = XLSX.write(workbook, { bookType: "xlsx", type: "array" })
    const fileName = `order-phones-${new Date().toISOString().split("T")[0]}.xlsx`
    return new NextResponse(excelBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
      },
    })
  } catch (error) {
    console.error("[PHONE-EXPORT] Internal Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
