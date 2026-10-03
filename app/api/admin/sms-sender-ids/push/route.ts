import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { pushSenderId } from "@/lib/sms/sender-id-service"

// POST /api/admin/sms-sender-ids/push — { id, provider: "moolre" | "mnotify" }
export async function POST(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  let body: { id?: string; provider?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }
  if (!body.id || (body.provider !== "moolre" && body.provider !== "mnotify")) {
    return NextResponse.json(
      { success: false, error: "id and provider ('moolre' | 'mnotify') are required" },
      { status: 400 }
    )
  }

  const result = await pushSenderId(body.id, body.provider)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  return NextResponse.json({ success: true, data: result.data })
}
