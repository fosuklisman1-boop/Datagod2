// app/api/admin/airtime/digiwapy-balance/route.ts
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { fetchDigiWapyBalance, isDigiWapyConfigured } from "@/lib/digiwapy-provider"

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  if (!isDigiWapyConfigured()) {
    return NextResponse.json({ error: "Digiwapy not configured" }, { status: 503 })
  }

  const balance = await fetchDigiWapyBalance()
  if (!balance) {
    return NextResponse.json({ error: "Failed to fetch Digiwapy balance" }, { status: 502 })
  }

  return NextResponse.json(balance)
}
