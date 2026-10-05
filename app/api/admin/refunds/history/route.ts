import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { badRequest, parsePage, refundDb, refundErrorResponse } from "@/lib/refunds/http"

const PAGE_SIZE = 50
const STATUSES = ["reserved", "processing", "awaiting_otp", "completed", "failed"]

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  try {
    const sp = new URL(request.url).searchParams
    const page = parsePage(sp.get("page"))
    if (page === null) return badRequest("Invalid page")
    const status = sp.get("status")
    if (status && !STATUSES.includes(status)) return badRequest("Invalid status")
    let q = refundDb().from("order_refunds").select("*").order("created_at", { ascending: false }).order("id", { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
    if (status) q = q.eq("status", status)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return NextResponse.json({ rows: data ?? [], page, pageSize: PAGE_SIZE })
  } catch (err) {
    return refundErrorResponse(err)
  }
}
