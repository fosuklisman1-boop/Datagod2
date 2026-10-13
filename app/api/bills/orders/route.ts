import { NextRequest, NextResponse } from "next/server"
import { getBillsRuntime, listUserBillOrders } from "@/lib/bills/runtime"
import { authenticate } from "@/lib/bills/route-auth"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if ("response" in auth) return auth.response
    const sp = new URL(request.url).searchParams
    const { db } = getBillsRuntime()
    const orders = await listUserBillOrders(db, auth.userId, {
      biller: sp.get("biller"), status: sp.get("status"), from: sp.get("from"), to: sp.get("to"),
    })
    return NextResponse.json({ orders })
  } catch (e) {
    console.error("[bills] orders error:", e instanceof Error ? e.message : "error")
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
