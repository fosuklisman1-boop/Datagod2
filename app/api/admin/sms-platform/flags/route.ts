import { NextRequest, NextResponse } from "next/server"
import { adminGuard } from "@/lib/sms/admin-guard"
import { listFlags, parsePage } from "@/lib/sms/admin-lists"

// GET ?severity=&status=&page=
export async function GET(request: NextRequest) {
  const g = await adminGuard(request)
  if (!g.ok) return g.response
  const sp = request.nextUrl.searchParams
  try {
    const data = await listFlags({ severity: sp.get("severity") ?? "", status: sp.get("status") ?? "open", page: parsePage(sp.get("page")) })
    return NextResponse.json({ success: true, data })
  } catch (e) {
    console.error("[SMS-ADMIN] flags failed:", e)
    return NextResponse.json({ success: false, error: "Could not load flags" }, { status: 500 })
  }
}
