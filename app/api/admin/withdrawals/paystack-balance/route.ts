import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getPaystackTransferBalance } from "@/lib/paystack-transfer"

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const balance = await getPaystackTransferBalance()
  if (!balance) {
    return NextResponse.json(
      { error: "Could not reach Paystack to fetch balance" },
      { status: 503 }
    )
  }

  return NextResponse.json(balance)
}
