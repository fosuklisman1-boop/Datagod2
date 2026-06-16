import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { listSenderIds, submitSenderId } from "@/lib/sms/sender-id-service"

// GET /api/admin/sms-sender-ids — list all sender IDs
export async function GET(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  const result = await listSenderIds()
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 500 })
  return NextResponse.json({ success: true, data: result.data })
}

// POST /api/admin/sms-sender-ids — submit a new sender ID  { sender_id }
export async function POST(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  let body: { sender_id?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  if (!body.sender_id) return NextResponse.json({ success: false, error: "sender_id is required" }, { status: 400 })

  const result = await submitSenderId(body.sender_id)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  return NextResponse.json({ success: true, data: result.data }, { status: 201 })
}
