import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { MTN_ROUTE_KEY, getActiveMtnNetworkId } from "@/lib/mtn-providers/datakazina-provider"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const action = request.nextUrl.searchParams.get("action")

  try {
    if (action === "mtn-route") {
      const networkId = await getActiveMtnNetworkId()
      return NextResponse.json({ success: true, route: networkId === 6 ? "mtn_express" : "mtn" })
    }
    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
  } catch (error) {
    console.error("[ADMIN-DATAKAZINA] GET error:", error)
    return NextResponse.json({ error: "DataKazina request failed" }, { status: 502 })
  }
}

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const body = await request.json()

    if (body.action === "set-mtn-route") {
      const route = body.route
      if (route !== "mtn" && route !== "mtn_express") {
        return NextResponse.json({ error: "Invalid route. Use: mtn, mtn_express" }, { status: 400 })
      }
      const { error } = await supabase
        .from("admin_settings")
        .upsert({ key: MTN_ROUTE_KEY, value: { route }, updated_at: new Date().toISOString() }, { onConflict: "key" })
      if (error) {
        console.error("[ADMIN-DATAKAZINA] Failed to save MTN route:", error)
        return NextResponse.json({ error: "Failed to save setting" }, { status: 500 })
      }
      return NextResponse.json({ success: true, route })
    }

    return NextResponse.json({ error: `Unknown action: ${body.action}` }, { status: 400 })
  } catch (error) {
    console.error("[ADMIN-DATAKAZINA] POST error:", error)
    return NextResponse.json({ error: "DataKazina request failed" }, { status: 502 })
  }
}
