import { NextRequest, NextResponse } from "next/server"
import { adminCheckStatus } from "@/lib/hubtel-cs/admin-actions"
import { auditLog, errorJson, requireAdmin, isValidRef } from "@/lib/hubtel-cs/admin-route"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"

export const dynamic = "force-dynamic"
export const maxDuration = 30

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  if (!auth.userId) return NextResponse.json({ error: "A signed-in admin is required to check status" }, { status: 403 })
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  if (!isValidRef(body?.ref)) return NextResponse.json({ error: "A valid ref is required" }, { status: 400 })
  try {
    const rt = getHubtelCsRuntime()
    const out = await adminCheckStatus(rt.adminDeps, body.ref)
    if (out.tx) auditLog(rt.db, { adminId: auth.userId, action: "hubtel_cs_check_status", newValue: { ref: body.ref, ok: out.ok, state: out.tx.state } })
    // Unknown reference -> 404; a failed status check is reported in the body (ok:false, message).
    return NextResponse.json(out, { status: out.tx ? 200 : 404 })
  } catch (e) {
    return errorJson(e)
  }
}
