// Admin exports. kind=report: all columns, filtered as the table. kind=supplier: one Phone column of open
// (status=blocked) numbers for a provider; mark=1 stamps those rows as submitted. Both are audited (counts only).
import { NextRequest, NextResponse } from "next/server"
import * as XLSX from "xlsx"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin } from "@/lib/supabase"
import { normalizeGhanaPhone } from "@/lib/phone-format"
import { getCustomerVerificationSettings } from "@/lib/mtn-providers/customer-verification"
import { EXPORT_LIMIT, chunked, parseListParams, supplierRows } from "@/lib/blocked-numbers/admin-view"
import { NUMBER_COLUMNS, applyFilters, shopIdsForSearch, shopNames, type NumberRow } from "@/lib/blocked-numbers/admin-query"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const CHUNK = 500
const READ_PAGE = 1000 // PostgREST caps a response at 1000 rows, so .limit(10000) would silently stop at 1000

/** Reads up to EXPORT_LIMIT rows in 1000-row pages. `build` must return a FRESH, deterministically ordered query each call. */
async function readPaged<T>(build: () => any): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; from < EXPORT_LIMIT; from += READ_PAGE) {
    const { data, error } = await build().range(from, from + READ_PAGE - 1)
    if (error) throw new Error(`export read failed: ${error.code ?? "db"}`)
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < READ_PAGE) break
  }
  return out
}

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

      const unsubmitted = sp.get("unsubmitted") === "1"
      const found = await readPaged<{ id: string; phone: string }>(() => {
        let q = supabaseAdmin.from("mtn_blocked_numbers").select("id, phone").eq("status", "blocked")
        if (unsubmitted) q = q.is("submitted_to_supplier", null)
        return q.order("first_blocked_at", { ascending: true }).order("id", { ascending: true })
      })
      const truncated = found.length >= EXPORT_LIMIT
      // Only rows whose phone actually lands in the sheet (normalised, deduped) are exported and marked.
      const seen = new Set<string>()
      const included: Array<{ id: string; phone: string }> = []
      for (const r of found) {
        const phone = typeof r.phone === "string" ? normalizeGhanaPhone(r.phone) : null
        if (!phone || seen.has(phone)) continue
        seen.add(phone)
        included.push({ id: r.id, phone })
      }
      const rows = supplierRows(included.map((r) => r.phone))

      let marked = 0
      if (mark && supplier && included.length > 0) {
        const now = new Date().toISOString()
        for (const part of chunked(included.map((r) => r.id), CHUNK)) {
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
      await audit(adminId, { kind, supplier: supplier ?? null, number_count: rows.length, marked_count: marked, truncated })
      return xlsxResponse(rows, ["Phone"], "Blocked MTN Numbers", `blocked-mtn-${day}.xlsx`, {
        "X-Number-Count": String(rows.length),
        "X-Marked-Count": String(marked),
        ...(truncated ? { "X-Truncated": "1" } : {}),
      })
    }

    // kind === "report": same filters as the table, all columns.
    const p = parseListParams(sp)
    const shopSearchIds = await shopIdsForSearch(supabaseAdmin, p.q)
    const numbers = await readPaged<NumberRow>(() =>
      applyFilters(supabaseAdmin.from("mtn_blocked_numbers").select(NUMBER_COLUMNS), p, shopSearchIds)
        .order("last_blocked_at", { ascending: false })
        .order("id", { ascending: true })
    )
    const truncated = numbers.length >= EXPORT_LIMIT
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
    await audit(adminId, { kind, number_count: rows.length, truncated })
    return xlsxResponse(rows, ["Phone", "Status"], "Blocked numbers", `blocked-numbers-report-${day}.xlsx`, {
      "X-Number-Count": String(rows.length),
      ...(truncated ? { "X-Truncated": "1" } : {}),
    })
  } catch (err) {
    console.error("[BLOCKED-ADMIN] export failed:", err instanceof Error ? err.message : "UnknownError")
    return NextResponse.json({ error: "Export failed" }, { status: 500 })
  }
}
