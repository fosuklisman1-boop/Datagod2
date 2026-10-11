import { NextRequest, NextResponse } from "next/server"
import { adminGuard } from "@/lib/sms/admin-guard"
import { approveSenderIdRequest, rejectSenderIdRequest, revokeSenderId } from "@/lib/sms/sender-rules-service"

// POST { action: "approve" | "reject" | "revoke", reason?: string }
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await adminGuard(request, { write: true })
  if (!g.ok) return g.response
  const { id } = await params
  let body: { action?: string; reason?: string }
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 }) }
  const adminId = g.adminId!
  const result =
    body.action === "approve" ? await approveSenderIdRequest(adminId, id) :
    body.action === "reject" ? await rejectSenderIdRequest(adminId, id, body.reason ?? "") :
    body.action === "revoke" ? await revokeSenderId(adminId, id, body.reason) :
    { ok: false as const, error: "action must be approve, reject or revoke" }
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  return NextResponse.json({ success: true, data: result.data })
}
