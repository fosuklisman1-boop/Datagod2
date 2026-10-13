import { NextResponse } from "next/server"
import { getBundlesRuntime, getBundlesAvailability } from "@/lib/standard-bundles/runtime"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const { db, deps } = getBundlesRuntime()
    return NextResponse.json(await getBundlesAvailability(db, deps.getHubtelConfig))
  } catch (e) {
    console.error("[bundles] availability error:", e instanceof Error ? e.message : "error")
    return NextResponse.json({ enabled: false, networks: [] })
  }
}
