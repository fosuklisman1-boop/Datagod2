import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getRoutingConfig, setRoutingConfig } from "@/lib/sms/routing"

// GET /api/admin/sms-settings — current provider routing
export async function GET(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  const routing = await getRoutingConfig()
  return NextResponse.json({ success: true, data: routing })
}

// PATCH /api/admin/sms-settings — update provider routing
// Body: { primary?: string; fallbacks?: string[] }
// Persists as JSONB into admin_settings and invalidates the routing cache.
export async function PATCH(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  let body: { primary?: string; fallbacks?: string[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const result = await setRoutingConfig({ primary: body.primary, fallbacks: body.fallbacks })
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })

  const routing = await getRoutingConfig()
  return NextResponse.json({ success: true, data: routing })
}
