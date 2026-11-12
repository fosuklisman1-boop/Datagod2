import { NextRequest, NextResponse } from "next/server"
import { getSupportDb, getSupportUser } from "@/lib/support-auth"
import { isSupportActive } from "@/lib/admin-presence"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const user = await getSupportUser(request)
  if (!user) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  const active = await isSupportActive(getSupportDb())
  return NextResponse.json({ success: true, data: { active } })
}
