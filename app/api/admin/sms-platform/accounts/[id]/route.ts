import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { setAccountMode, setApiRateLimitOverride } from "@/lib/sms/sender-rules-service"

// PATCH { mode?: "platform" | "business", api_rate_limit_override?: number | null }
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!
  const { id } = await params
  let body: { mode?: string; api_rate_limit_override?: number | null }
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 }) }
  const adminId = auth.userId ?? null
  const out: Record<string, unknown> = {}
  if (body.mode !== undefined) {
    if (body.mode !== "platform" && body.mode !== "business") return NextResponse.json({ success: false, error: "mode must be platform or business" }, { status: 400 })
    const r = await setAccountMode(adminId, id, body.mode)
    if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 400 })
    out.mode = r.data
  }
  if (body.api_rate_limit_override !== undefined) {
    const r = await setApiRateLimitOverride(adminId, id, body.api_rate_limit_override)
    if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 400 })
    out.api_rate_limit_override = r.data.api_rate_limit_override
  }
  return NextResponse.json({ success: true, data: out })
}
