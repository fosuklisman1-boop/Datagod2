import { NextResponse } from "next/server"
import { getBillsRuntime, getBillsAvailability } from "@/lib/bills/runtime"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const { db } = getBillsRuntime()
    return NextResponse.json(await getBillsAvailability(db))
  } catch (e) {
    console.error("[bills] availability error:", e instanceof Error ? e.message : "error")
    return NextResponse.json({ error: "Temporarily unavailable" }, { status: 500 })
  }
}
