import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function fetchAllResults(sessionId: string) {
  const results: any[] = []
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from("phone_verification_results")
      .select("phone_number, account_name, network, status, whitelist_provider")
      .eq("session_id", sessionId)
      .order("status", { ascending: false })
      .range(from, from + 999)
    if (error) throw error
    if (!data || data.length === 0) break
    results.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
  return results
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const { id } = await params

  try {
    const { data: session, error: sessionError } = await supabase
      .from("phone_verification_sessions")
      .select("id, file_name, check_type")
      .eq("id", id)
      .single()

    if (sessionError || !session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 })
    }

    const allResults = await fetchAllResults(id)

    const XLSX = await import("xlsx")

    const isWhitelist = session.check_type === "mtn_whitelist"
    // A "blocked" export only makes sense for whitelist sessions — Moolre
    // sessions always export verified-only, regardless of the query param.
    const requestedStatus = new URL(request.url).searchParams.get("status")
    const isBlockedExport = isWhitelist && requestedStatus === "invalid"
    const exportStatus = isBlockedExport ? "invalid" : "verified"

    const toRow = (r: any) => isBlockedExport
      ? {
          "Phone Number": r.phone_number,
          "Network": r.network,
          "Status": "Blocked",
        }
      : isWhitelist
        ? {
            "Phone Number": r.phone_number,
            "Network": r.network,
            "Allowed By": r.whitelist_provider ?? "",
            "Status": "Allowed",
          }
        : {
            "Phone Number": r.phone_number,
            "Account Name": r.account_name ?? "",
            "Network": r.network,
            "Status": "Verified",
          }

    const sheetName = isBlockedExport ? "Blocked" : isWhitelist ? "Allowed" : "Verified"

    // Each export contains exactly one status: verified/allowed by default,
    // or blocked when explicitly requested (whitelist sessions only) —
    // duplicates and not-applicable rows are never exported either way.
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(allResults.filter(r => r.status === exportStatus).map(toRow)),
      sheetName
    )

    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" })
    const date = new Date().toISOString().split("T")[0]
    const filename = `verification-${id.slice(0, 8)}-${sheetName.toLowerCase()}-${date}.xlsx`

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    })
  } catch (error) {
    console.error("[PHONE-VERIFY-EXPORT]", error)
    return NextResponse.json({ error: "Export failed" }, { status: 500 })
  }
}
