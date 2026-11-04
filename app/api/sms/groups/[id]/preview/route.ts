import { NextRequest, NextResponse } from "next/server"
import { resolveAccount } from "@/lib/sms/tenant-auth"
import { getGroupActiveCount } from "@/lib/sms/tenant-address-book-service"
import { loadSmsSettings } from "@/lib/sms/platform-settings"
import { effectivePerSend } from "@/lib/sms/send-limits"

// GET /api/sms/groups/[id]/preview — active (opted-in) recipient count for the
// pre-send confirmation. { activeCount, sentCount } where sentCount = what a send
// would actually reach: capped at the account's admin per-send limit (within the
// 5,000 auto-batch ceiling) — the same cut /api/shop/sms/send applies.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { account, error } = await resolveAccount(request)
  if (error) return error
  const { id } = await params
  const perSend = effectivePerSend(await loadSmsSettings(), account.mode)
  const result = await getGroupActiveCount(account.id, id, perSend)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 404 })
  return NextResponse.json({ success: true, data: result.data })
}
