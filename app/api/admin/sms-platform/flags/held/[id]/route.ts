import { NextRequest, NextResponse } from "next/server"
import { adminGuard } from "@/lib/sms/admin-guard"
import { parseLogId, rejectHeldCampaign, releaseHeldCampaign, type HeldErrorCode } from "@/lib/sms/held-service"

// Release dispatches up to 500 messages inline (same budget as the customer send route).
export const maxDuration = 300

const STATUS: Record<HeldErrorCode, number> = {
  INVALID: 400, NOT_FOUND: 404, NOT_HELD: 409, REJECTED: 409, SMS_DISABLED: 409, DB: 500,
}

// POST { action: "release" | "reject", reason?: string }   [id] = sms_send_logs.id of the held campaign
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await adminGuard(request, { write: true })
  if (!g.ok) return g.response
  const { id } = await params
  const logId = parseLogId(id)
  if (logId === null) return NextResponse.json({ success: false, error: "Invalid campaign id" }, { status: 400 })

  let body: { action?: unknown; reason?: unknown }
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 }) }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }
  if (body.action !== "release" && body.action !== "reject") {
    return NextResponse.json({ success: false, error: "action must be 'release' or 'reject'" }, { status: 400 })
  }

  const r = body.action === "release"
    ? await releaseHeldCampaign(g.adminId!, logId)
    : await rejectHeldCampaign(g.adminId!, logId, typeof body.reason === "string" ? body.reason : "")
  if (!r.ok) return NextResponse.json({ success: false, error: r.error, code: r.code }, { status: STATUS[r.code] ?? 500 })
  const { ok: _ok, ...data } = r
  return NextResponse.json({ success: true, data })
}
