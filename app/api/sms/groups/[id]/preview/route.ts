import { NextRequest, NextResponse } from "next/server"
import { resolveAccount } from "@/lib/sms/tenant-auth"
import { getGroupActiveCount } from "@/lib/sms/tenant-address-book-service"
import { SMS_MAX_TOTAL } from "@/lib/sms/send-service"

// GET /api/sms/groups/[id]/preview — active (opted-in) recipient count for the
// pre-send confirmation. { activeCount, sentCount } where sentCount = what a send
// would actually reach (capped at the auto-batch ceiling SMS_MAX_TOTAL).
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { account, error } = await resolveAccount(request)
  if (error) return error
  const { id } = await params
  const result = await getGroupActiveCount(account.id, id, SMS_MAX_TOTAL)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 404 })
  return NextResponse.json({ success: true, data: result.data })
}
