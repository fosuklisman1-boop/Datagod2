import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { rejectSenderId } from "@/lib/sms/sender-id-service"

// POST /api/admin/sms-sender-ids/reject — { id, provider: "moolre" | "mnotify" | "both" }
export async function POST(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  let body: { id?: string; provider?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }
  if (!body.id || !["moolre", "mnotify", "both"].includes(body.provider ?? "")) {
    return NextResponse.json(
      { success: false, error: "id and provider ('moolre' | 'mnotify' | 'both') are required" },
      { status: 400 }
    )
  }

  const result = await rejectSenderId(body.id, body.provider as "moolre" | "mnotify" | "both")
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  return NextResponse.json({ success: true, data: result.data })
}
