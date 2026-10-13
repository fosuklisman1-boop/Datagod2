import { NextRequest, NextResponse } from "next/server"
import { resolveAccount } from "@/lib/sms/tenant-auth"
import { getRecord } from "@/lib/sms/customer-reads"

// GET /api/sms/logs/[id] — one send batch + its per-recipient rows (scoped to the
// caller's account). Powers the Records detail view. `log` and `messages` keep their
// original keys; messages gain delivery_status/refunded and `counts` is new.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await resolveAccount(request)
  if (auth.error) return auth.error

  const { id } = await params
  const logId = Number(id)
  if (!Number.isInteger(logId) || logId < 1) {
    return NextResponse.json({ success: false, error: "Invalid id" }, { status: 400 })
  }

  try {
    const record = await getRecord(auth.account.id, logId)
    if (!record) return NextResponse.json({ success: false, error: "Batch not found" }, { status: 404 })
    return NextResponse.json({ success: true, data: record })
  } catch (e) {
    console.error("[SMS-LOGS] Detail error:", e)
    return NextResponse.json({ success: false, error: "Failed to fetch batch" }, { status: 500 })
  }
}
