import { NextRequest, NextResponse } from "next/server"
import { adminGuard } from "@/lib/sms/admin-guard"
import { listSenderIdsForAdmin } from "@/lib/sms/admin-reviews"

// GET ?status=pending|active|paused|rejected|revoked|all&scope=tenant|global|all
export async function GET(request: NextRequest) {
  const g = await adminGuard(request)
  if (!g.ok) return g.response
  const sp = request.nextUrl.searchParams
  const scope = sp.get("scope")
  try {
    const data = await listSenderIdsForAdmin(sp.get("status") ?? "all", scope === "tenant" || scope === "global" ? scope : "all")
    return NextResponse.json({ success: true, data })
  } catch (e) {
    console.error("[SMS-ADMIN] sender ids failed:", e)
    return NextResponse.json({ success: false, error: "Could not load sender IDs" }, { status: 500 })
  }
}
