import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getInventorySummary, markVouchersInvalid } from "@/lib/results-checker-inventory-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const { searchParams } = new URL(request.url)
    const examBoard = searchParams.get("examBoard")
    const status = searchParams.get("status")
    const batchId = searchParams.get("batchId")
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"))
    const limit = Math.min(100, parseInt(searchParams.get("limit") ?? "50"))
    const offset = (page - 1) * limit

    let query = supabase
      .from("results_checker_inventory")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1)

    if (examBoard) query = query.eq("exam_board", examBoard)
    if (status) query = query.eq("status", status)
    if (batchId) query = query.eq("batch_id", batchId)

    const { data: items, count, error } = await query
    if (error) throw error

    const summary = await getInventorySummary()

    return NextResponse.json({ items, total: count ?? 0, page, limit, summary })

  } catch (error) {
    console.error("[RC-INVENTORY] GET error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const { action, ids } = await request.json()

    if (action === "mark_invalid") {
      if (!Array.isArray(ids) || ids.length === 0) {
        return NextResponse.json({ error: "ids array is required" }, { status: 400 })
      }
      await markVouchersInvalid(ids)
      return NextResponse.json({ success: true, message: `${ids.length} voucher(s) marked as invalid` })
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 })

  } catch (error) {
    console.error("[RC-INVENTORY] PATCH error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
