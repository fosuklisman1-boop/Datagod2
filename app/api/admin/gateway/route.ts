import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { SURFACE_KEYS, validateGatewayConfigUpdate } from "@/lib/payment-gateway/config"
import { getGatewayConfig } from "@/lib/payment-gateway/read-config"
import { saveGatewayConfig } from "@/lib/payment-gateway/write-config"
import { hubtelReadinessReport, isHubtelCollectionReady } from "@/lib/payment-gateway/hubtel-readiness"

/** GET /api/admin/gateway -> current per-surface config + Hubtel readiness (names only). */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const config = await getGatewayConfig()
    return NextResponse.json({ success: true, config, hubtel: hubtelReadinessReport() })
  } catch (e) {
    console.error("[ADMIN-GATEWAY] GET error:", e)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

/** PUT /api/admin/gateway  { config } */
export async function PUT(request: NextRequest) {
  const { isAdmin, userId, userEmail, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    let body: { config?: unknown }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
    }

    const result = validateGatewayConfigUpdate(body?.config, { hubtelReady: isHubtelCollectionReady() })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })

    const previous = await getGatewayConfig()
    const actor = userEmail ?? userId ?? "unknown"
    await saveGatewayConfig(supabase, result.config, actor)

    const changed = SURFACE_KEYS.filter(
      (k) => JSON.stringify(previous.surfaces[k]) !== JSON.stringify(result.config.surfaces[k]),
    )
    console.warn(
      `[ADMIN-GATEWAY] Payment gateway config updated by ${actor}; changed surfaces: ${changed.join(", ") || "none"}`,
    )
    return NextResponse.json({ success: true, config: result.config })
  } catch (e) {
    console.error("[ADMIN-GATEWAY] PUT error:", e)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
