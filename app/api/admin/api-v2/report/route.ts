import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getAdminClient } from "@/lib/api-v2/store"
import type { RpcClient } from "@/lib/api-v2/approvals"
import { loadReport } from "@/lib/api-v2/admin-console/report"

/** GET /api/admin/api-v2/report?from=&to=&by=&format=csv - Admin: the business report (JSON or a CSV download). */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  const out = await loadReport(getAdminClient() as RpcClient, new URL(request.url).searchParams, new Date())
  if (out.kind === "csv") {
    return new NextResponse(out.csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${out.filename}"`,
        "Cache-Control": "no-store",
      },
    })
  }
  return NextResponse.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } })
}
