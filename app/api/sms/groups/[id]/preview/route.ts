import { NextRequest, NextResponse } from "next/server"
import { resolveAccount } from "@/lib/sms/tenant-auth"
import { getGroupActiveCount } from "@/lib/sms/tenant-address-book-service"

// GET /api/sms/groups/[id]/preview — active (opted-in) recipient count for the
// pre-send confirmation. { activeCount, sentCount } (sentCount = min(active, 500)).
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { account, error } = await resolveAccount(request)
  if (error) return error
  const { id } = await params
  const result = await getGroupActiveCount(account.id, id)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 404 })
  return NextResponse.json({ success: true, data: result.data })
}
