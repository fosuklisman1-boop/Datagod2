import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { notifySenderIdOutcome } from "@/lib/admin-actions/sender-id-hook"
import { rejectSenderId, getById } from "@/lib/sms/sender-id-service"
import { rejectSenderIdRequest } from "@/lib/sms/sender-rules-service"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

// POST /api/admin/sms-sender-ids/reject — { id, provider: "moolre" | "mnotify" | "both" }
export async function POST(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  let body: { id?: string; provider?: string; reason?: string }
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

  const owned = await getById(body.id)
  if (owned?.sms_account_id) {
    if (!auth.userId) return NextResponse.json({ success: false, error: "Admin user required" }, { status: 403 })
    const r = await rejectSenderIdRequest(auth.userId,body.id, body.reason?.trim() || "Rejected by admin")
    if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 400 })
    await notifySenderIdOutcome(supabaseAdmin, r.data, "rejected", body.reason?.trim() || "Rejected by admin")
    return NextResponse.json({ success: true, data: r.data })
  }

  const result = await rejectSenderId(body.id, body.provider as "moolre" | "mnotify" | "both")
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  return NextResponse.json({ success: true, data: result.data })
}
