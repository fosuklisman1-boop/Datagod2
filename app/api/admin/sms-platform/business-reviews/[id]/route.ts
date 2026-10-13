import { NextRequest, NextResponse } from "next/server"
import { adminGuard } from "@/lib/sms/admin-guard"
import { approveKyc, getKycForAdmin, rejectKyc, retryKycModeChange, toPublicKyc } from "@/lib/sms/kyc-service"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await adminGuard(request)
  if (!g.ok) return g.response
  const { id } = await params
  const p = await getKycForAdmin(g.adminId!, id)
  if (!p) return NextResponse.json({ success: false, error: "Not found" }, { status: 404 })
  return NextResponse.json({ success: true, data: p })
}

// POST { action: "approve" | "reject", reason?: string }
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await adminGuard(request, { write: true })
  if (!g.ok) return g.response
  const { id } = await params
  let body: { action?: string; reason?: string }
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 }) }
  const adminId = g.adminId!

  if (body?.action === "approve") {
    const r = await approveKyc(adminId, id)
    if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 400 })
    const { modeChange, ...profile } = r.data
    if (!modeChange.ok) {
      // The approval is recorded but the account is NOT in Business mode yet — never report plain success.
      return NextResponse.json({
        success: false, approved: true, data: toPublicKyc(profile),
        error: `Application approved, but the account could not be switched to Business mode: ${modeChange.error} Retry with POST { "action": "retry_mode" } on this application.`,
      }, { status: 500 })
    }
    return NextResponse.json({ success: true, data: { ...toPublicKyc(profile), modeChange } })
  }
  if (body?.action === "retry_mode") {
    const r = await retryKycModeChange(adminId, id)
    if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: r.status ?? 500 })
    return NextResponse.json({ success: true, data: r.data })
  }
  if (body?.action === "reject") {
    const r = await rejectKyc(adminId, id, body.reason ?? "")
    if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 400 })
    return NextResponse.json({ success: true, data: toPublicKyc(r.data) })
  }
  return NextResponse.json({ success: false, error: "action must be approve, reject or retry_mode" }, { status: 400 })
}
