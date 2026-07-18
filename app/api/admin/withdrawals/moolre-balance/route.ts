import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getMoolreTransferBalance } from "@/lib/moolre-transfer"

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const balance = await getMoolreTransferBalance()
  if (!balance) {
    return NextResponse.json(
      { error: "Could not reach Moolre to fetch wallet balance" },
      { status: 503 }
    )
  }

  return NextResponse.json(balance)
}
