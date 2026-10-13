import { NextRequest, NextResponse } from "next/server"
import { adminGuard } from "@/lib/sms/admin-guard"
import { getOverview } from "@/lib/sms/admin-overview"

export async function GET(request: NextRequest) {
  const g = await adminGuard(request)
  if (!g.ok) return g.response
  try {
    return NextResponse.json({ success: true, data: await getOverview() })
  } catch (e) {
    console.error("[SMS-ADMIN] overview failed:", e)
    return NextResponse.json({ success: false, error: "Could not load the overview" }, { status: 500 })
  }
}
