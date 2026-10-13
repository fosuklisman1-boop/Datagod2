import { NextRequest, NextResponse } from "next/server"
import { adminResolve } from "@/lib/hubtel-cs/admin-actions"
import { auditLog, errorJson, requireAdmin } from "@/lib/hubtel-cs/admin-route"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"

export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  if (!auth.userId) return NextResponse.json({ error: "A signed-in admin is required to resolve" }, { status: 403 })
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  if (typeof body?.ref !== "string" || !body.ref) return NextResponse.json({ error: "ref is required" }, { status: 400 })
  if (body.outcome !== "fulfilled" && body.outcome !== "failed") return NextResponse.json({ error: "outcome must be 'fulfilled' or 'failed'" }, { status: 400 })
  try {
    const rt = getHubtelCsRuntime()
    const out = await adminResolve(rt.adminDeps, body.ref, body.outcome, String(body.note ?? ""), auth.userId)
    if (out.ok) auditLog(rt.db, { adminId: auth.userId, action: "hubtel_cs_resolve", newValue: { ref: body.ref, outcome: body.outcome, note: body.note } })
    return NextResponse.json(out, { status: out.ok ? 200 : 409 })
  } catch (e) {
    return errorJson(e)
  }
}
