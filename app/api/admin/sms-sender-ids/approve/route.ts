import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { approveSenderId, getById } from "@/lib/sms/sender-id-service"
import { approveSenderIdRequest } from "@/lib/sms/sender-rules-service"

// POST /api/admin/sms-sender-ids/approve — { id, provider: "moolre" | "mnotify" | "both" }
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

  // Tenant-owned rows are approved by our own rules, never by a provider override.
  const owned = await getById(body.id)
  if (owned?.sms_account_id) {
    const r = await approveSenderIdRequest(auth.userId ?? null, body.id)
    if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 400 })
    return NextResponse.json({ success: true, data: r.data })
  }

  const result = await approveSenderId(body.id, body.provider as "moolre" | "mnotify" | "both")
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  return NextResponse.json({ success: true, data: result.data })
}
