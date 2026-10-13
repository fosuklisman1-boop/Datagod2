import { NextRequest, NextResponse } from "next/server"
import { getBundlesRuntime, listUserDataOrders } from "@/lib/standard-bundles/runtime"
import { authenticate } from "@/lib/bills/route-auth"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if ("response" in auth) return auth.response
    const { db } = getBundlesRuntime()
    const orders = await listUserDataOrders(db, auth.userId)
    return NextResponse.json({ orders })
  } catch (e) {
    console.error("[bundles] orders error:", e instanceof Error ? e.message : "error")
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
