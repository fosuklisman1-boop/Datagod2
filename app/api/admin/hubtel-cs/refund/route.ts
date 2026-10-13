import { NextRequest, NextResponse } from "next/server"
import { adminRefund } from "@/lib/hubtel-cs/admin-actions"
import { auditLog, errorJson, requireAdmin } from "@/lib/hubtel-cs/admin-route"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"

export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  if (!auth.userId) return NextResponse.json({ error: "A signed-in admin is required to refund" }, { status: 403 })
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  if (typeof body?.ref !== "string" || !body.ref) return NextResponse.json({ error: "ref is required" }, { status: 400 })
  if (body.force !== undefined && typeof body.force !== "boolean") return NextResponse.json({ error: "force must be a boolean" }, { status: 400 })
  const force = body.force === true
  try {
    const rt = getHubtelCsRuntime()
    const out = await adminRefund(rt.adminDeps, body.ref, auth.userId, { force })
    auditLog(rt.db, { adminId: auth.userId, action: "hubtel_cs_refund", newValue: { ref: body.ref, force, ok: out.ok, message: out.message } })
    return NextResponse.json({ ok: out.ok, message: out.message, provenance: out.provenance ?? null, tx: out.tx }, { status: out.ok ? 200 : 409 })
  } catch (e) {
    return errorJson(e)
  }
}
