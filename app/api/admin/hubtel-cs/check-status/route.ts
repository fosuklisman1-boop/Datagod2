import { NextRequest, NextResponse } from "next/server"
import { adminCheckStatus } from "@/lib/hubtel-cs/admin-actions"
import { errorJson, requireAdmin, isValidRef } from "@/lib/hubtel-cs/admin-route"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"

export const dynamic = "force-dynamic"
export const maxDuration = 30

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  if (!isValidRef(body?.ref)) return NextResponse.json({ error: "A valid ref is required" }, { status: 400 })
  try {
    const out = await adminCheckStatus(getHubtelCsRuntime().adminDeps, body.ref)
    // Unknown reference -> 404; a failed status check is reported in the body (ok:false, message).
    return NextResponse.json(out, { status: out.tx ? 200 : 404 })
  } catch (e) {
    return errorJson(e)
  }
}
