import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { isHubnetConfigured } from "@/lib/hubnet/client"
import { HubnetProvider } from "@/lib/mtn-providers/hubnet-provider"

export const dynamic = "force-dynamic"

// Admin read-only status for the Hubnet card. Never returns the API key or webhook token.
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const action = request.nextUrl.searchParams.get("action")
  if (action !== "balance") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  }

  const configured = isHubnetConfigured()
  const mode: "live" | "test" = process.env.HUBNET_MODE === "test" ? "test" : "live"
  let balance: number | null = null
  if (configured) {
    try {
      balance = await new HubnetProvider().checkBalance()
    } catch {
      balance = null
    }
  }
  return NextResponse.json({ balance, mode, configured })
}
