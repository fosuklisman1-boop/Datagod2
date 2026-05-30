import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const { searchParams } = new URL(request.url)
    const statusFilter = searchParams.get("status") ?? "all"
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"))
    const pageSize = 100
    const from = (page - 1) * pageSize
    const to = from + pageSize - 1

    const { data: session, error: sessionError } = await supabase
      .from("phone_verification_sessions")
      .select("id, file_name, total_count, verified_count, invalid_count, status, created_at, completed_at")
      .eq("id", params.id)
      .single()

    if (sessionError || !session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 })
    }

    let query = supabase
      .from("phone_verification_results")
      .select("id, phone_number, account_name, network, status, verified_at", { count: "exact" })
      .eq("session_id", params.id)
      .order("status", { ascending: false })
      .range(from, to)

    if (statusFilter !== "all") {
      query = query.eq("status", statusFilter)
    }

    const { data: results, error: resultsError, count } = await query
    if (resultsError) throw resultsError

    return NextResponse.json({
      session,
      results: results ?? [],
      total: count ?? 0,
      page,
      pages: Math.ceil((count ?? 0) / pageSize),
    })
  } catch (error) {
    console.error("[PHONE-VERIFY-SESSION]", error)
    return NextResponse.json({ error: "Failed to fetch session" }, { status: 500 })
  }
}
