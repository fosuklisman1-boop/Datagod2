import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { setAccountMode, setApiRateLimitOverride } from "@/lib/sms/sender-rules-service"

// PATCH { mode?: "platform" | "business", api_rate_limit_override?: number | null }
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!
  if (!auth.userId) return NextResponse.json({ success: false, error: "Admin user required" }, { status: 403 })
  const { id } = await params
  let body: { mode?: string; api_rate_limit_override?: number | null }
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 }) }
  const adminId = auth.userId
  const rl = body.api_rate_limit_override
  if (body.mode === undefined && rl === undefined) return NextResponse.json({ success: false, error: "Nothing to update" }, { status: 400 })
  if (body.mode !== undefined && body.mode !== "platform" && body.mode !== "business") return NextResponse.json({ success: false, error: "mode must be platform or business" }, { status: 400 })
  if (rl !== undefined && rl !== null && !(Number.isInteger(rl) && rl >= 1 && rl <= 10_000)) return NextResponse.json({ success: false, error: "api_rate_limit_override must be null or a whole number from 1 to 10000" }, { status: 400 })
  const out: Record<string, unknown> = {}
  if (body.mode !== undefined) {
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
