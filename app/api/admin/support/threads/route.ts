import { NextRequest, NextResponse } from "next/server"
import { getSupportDb, requireSupportAdmin } from "@/lib/support-auth"
import { touchAdminPresence } from "@/lib/admin-presence"
import { clampDays, loadAdminThreadList, type ThreadStatusFilter } from "@/lib/support-admin-data"

export const dynamic = "force-dynamic"

const fail = (error: string, status: number) => NextResponse.json({ success: false, error }, { status })

export async function GET(request: NextRequest) {
  const auth = await requireSupportAdmin(request)
  if ("response" in auth) return auth.response

  try {
    const params = request.nextUrl.searchParams
    const raw = params.get("status")
    const status: ThreadStatusFilter = raw === "closed" || raw === "all" ? raw : "open"
    const days = clampDays(params.get("days"))

    const db = getSupportDb()
    await touchAdminPresence(db, auth.adminId)
    const threads = await loadAdminThreadList(db, { status, days })
    return NextResponse.json({ success: true, data: { threads } })
  } catch {
    console.error("[SUPPORT] admin thread list failed", { adminId: auth.adminId })
    return fail("Something went wrong. Please try again.", 500)
  }
}
