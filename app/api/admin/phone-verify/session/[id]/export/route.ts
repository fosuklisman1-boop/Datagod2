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
      .select("phone_number, account_name, network, status")
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
      .select("id, file_name")
      .eq("id", id)
      .single()

    if (sessionError || !session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 })
    }

    const allResults = await fetchAllResults(id)

    const XLSX = await import("xlsx")

    const toRow = (r: any) => ({
      "Phone Number": r.phone_number,
      "Account Name": r.account_name ?? "",
      "Network": r.network,
      "Status": r.status === "verified" ? "Verified" : r.status === "invalid" ? "Invalid" : "Pending",
    })

    // Export contains verified numbers only — never invalids or duplicates.
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(allResults.filter(r => r.status === "verified").map(toRow)),
      "Verified"
    )

    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" })
    const date = new Date().toISOString().split("T")[0]
    const filename = `verification-${id.slice(0, 8)}-${date}.xlsx`

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
