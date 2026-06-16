import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { pollSenderIds } from "@/lib/sms/sender-id-service"

// POST /api/admin/sms-sender-ids/poll — reconcile pending sender IDs against Moolre
export async function POST(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  const result = await pollSenderIds()
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 500 })
  return NextResponse.json({ success: true, data: result.data })
}
