// Admin exports. kind=report: all columns, filtered as the table. kind=supplier: one Phone column of open
// (status=blocked) numbers for a provider; mark=1 stamps those rows as submitted. Both are audited (counts only).
import { NextRequest, NextResponse } from "next/server"
import * as XLSX from "xlsx"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin } from "@/lib/supabase"
import { getCustomerVerificationSettings } from "@/lib/mtn-providers/customer-verification"
import { EXPORT_LIMIT, chunked, parseListParams, supplierRows } from "@/lib/blocked-numbers/admin-view"
import { NUMBER_COLUMNS, applyFilters, shopIdsForSearch, shopNames, type NumberRow } from "@/lib/blocked-numbers/admin-query"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const CHUNK = 500

async function audit(adminId: string | null | undefined, value: Record<string, unknown>) {
  // Best-effort, awaited so the row is written before the function freezes. Counts only, never phones.
  try {
    const { error } = await supabaseAdmin.from("admin_audit_log").insert([
      { admin_id: adminId || null, action: "export_blocked_numbers", new_value: value, created_at: new Date().toISOString() },
    ])
    if (error) console.warn("[BLOCKED-ADMIN] audit insert failed")
  } catch {
    console.warn("[BLOCKED-ADMIN] audit insert threw")
  }
}

function xlsxResponse(rows: Array<Record<string, unknown>>, header: string[], sheet: string, fileName: string, extra: Record<string, string>) {
  const wb = XLSX.utils.book_new()
  const ws = rows.length ? XLSX.utils.json_to_sheet(rows) : XLSX.utils.json_to_sheet([], { header })
  XLSX.utils.book_append_sheet(wb, ws, sheet)
  const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" })
  return new NextResponse(buf, {
    headers: {
      "Content-Type": XLSX_TYPE,
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
      ...extra,
    },
  })
}

export async function GET(request: NextRequest) {
  const { isAdmin, userId: adminId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const sp = new URL(request.url).searchParams
  const kind = sp.get("kind")
  if (kind !== "report" && kind !== "supplier") {
    return NextResponse.json({ error: "kind must be report or supplier" }, { status: 400 })
  }
  const day = new Date().toISOString().slice(0, 10)

  try {
    if (kind === "supplier") {
      const supplier = sp.get("supplier")
      const mark = sp.get("mark") === "1"
      if (mark && !supplier) return NextResponse.json({ error: "supplier is required to mark numbers as submitted" }, { status: 400 })
      if (supplier) {
        const { providers } = await getCustomerVerificationSettings()
        if (!providers.includes(supplier)) {
          return NextResponse.json({ error: "supplier must be one of the current checkout providers" }, { status: 400 })
        }
      }

      const { data, error } = await supabaseAdmin
        .from("mtn_blocked_numbers")
        .select("id, phone")
        .eq("status", "blocked")
        .order("first_blocked_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(EXPORT_LIMIT)
      if (error) throw new Error(`export read failed: ${error.code ?? "db"}`)
      const found = (data ?? []) as Array<{ id: string; phone: string }>
      const rows = supplierRows(found.map((r) => r.phone))

      let marked = 0
      if (mark && supplier && found.length > 0) {
        const now = new Date().toISOString()
        for (const part of chunked(found.map((r) => r.id), CHUNK)) {
          const upd = await supabaseAdmin
            .from("mtn_blocked_numbers")
            .update({ submitted_to_supplier: supplier, submitted_at: now, updated_at: now })
            .in("id", part)
            .eq("status", "blocked")
            .select("id")
          if (upd.error) throw new Error(`mark failed: ${upd.error.code ?? "db"}`)
          marked += upd.data?.length ?? 0
        }
      }
      await audit(adminId, { kind, supplier: supplier ?? null, number_count: rows.length, marked_count: marked })
      return xlsxResponse(rows, ["Phone"], "Blocked MTN Numbers", `blocked-mtn-${day}.xlsx`, {
        "X-Number-Count": String(rows.length),
        "X-Marked-Count": String(marked),
      })
    }

    // kind === "report": same filters as the table, all columns.
    const p = parseListParams(sp)
    const shopSearchIds = await shopIdsForSearch(supabaseAdmin, p.q)
    const { data, error } = await applyFilters(supabaseAdmin.from("mtn_blocked_numbers").select(NUMBER_COLUMNS), p, shopSearchIds)
      .order("last_blocked_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(EXPORT_LIMIT)
    if (error) throw new Error(`export read failed: ${error.code ?? "db"}`)
    const numbers = (data ?? []) as NumberRow[]
    const names = await shopNames(supabaseAdmin, numbers.flatMap((n) => (n.last_shop_id ? [n.last_shop_id] : [])))
    const rows = numbers.map((n) => ({
      Phone: n.phone,
      Status: n.status,
      "First blocked": n.first_blocked_at,
      "Last blocked": n.last_blocked_at,
      Attempts: n.attempts,
      "Last surface": n.last_surface,
      Shop: n.last_shop_id ? (names.get(n.last_shop_id) ?? "Unnamed shop") : "",
      "Providers rejected": (n.providers_rejected ?? []).join(", "),
      "Re-checks": n.recheck_count,
      "Last re-check": n.last_rechecked_at,
      "Allowed at": n.allowed_at,
      "Allowed by": n.allowed_by,
      "Submitted to": n.submitted_to_supplier,
      "Submitted at": n.submitted_at,
      "Customer texted": n.customer_notified_at,
      "Handled at": n.handled_at,
      Notes: n.notes,
      Expires: n.expires_at,
    }))
    await audit(adminId, { kind, number_count: rows.length })
    return xlsxResponse(rows, ["Phone", "Status"], "Blocked numbers", `blocked-numbers-report-${day}.xlsx`, {
      "X-Number-Count": String(rows.length),
    })
  } catch (err) {
    console.error("[BLOCKED-ADMIN] export failed:", err instanceof Error ? err.message : "UnknownError")
    return NextResponse.json({ error: "Export failed" }, { status: 500 })
  }
}
