import { NextRequest, NextResponse } from "next/server"
import { resolveAccount } from "@/lib/sms/tenant-auth"
import { cancelScheduledCampaign } from "@/lib/sms/scheduled-service"

const STATUS: Record<string, number> = { INVALID: 400, NOT_FOUND: 404, NOT_SCHEDULED: 409, DB: 500 }

// POST /api/sms/logs/[id]/cancel — cancel one of the caller's scheduled sends and refund its
// credits. Ownership is enforced in SQL: another account's log answers 404, same as a missing one.
// Never blocked by the SMS master switch.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await resolveAccount(request)
  if (auth.error) return auth.error

  const { id } = await params
  try {
    const r = await cancelScheduledCampaign(auth.account.id, id, "cancelled by customer")
    if (!r.ok) {
      return NextResponse.json({ success: false, error: r.error, code: r.code }, { status: STATUS[r.code] ?? 500 })
    }
    return NextResponse.json({
      success: true,
      data: { cancelled: true, ...(r.already ? { already: true } : {}), refunded: r.refunded },
    })
  } catch (e) {
    console.error("[SMS-LOGS] Cancel error:", e)
    return NextResponse.json({ success: false, error: "Could not cancel the scheduled campaign" }, { status: 500 })
  }
}
