import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { allocateUnits } from "@/lib/sms/bundle-service"

export async function POST(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!
  const { accountId, units } = await request.json()
  if (!accountId || !units) return NextResponse.json({ error: "accountId and units required" }, { status: 400 })
  const result = await allocateUnits(accountId, Number(units))
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json({ success: true, pending: result.pending ?? false, unitsCredited: result.unitsCredited ?? 0 })
}
