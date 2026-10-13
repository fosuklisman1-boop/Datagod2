import { NextRequest, NextResponse } from "next/server"
import { resolveAccount } from "@/lib/sms/tenant-auth"
import { listLedger } from "@/lib/sms/customer-reads"

// GET /api/sms/ledger?page= — paged credit history (25/page, newest first). Not kill-switched.
export async function GET(request: NextRequest) {
  const auth = await resolveAccount(request)
  if (auth.error) return auth.error
  const n = Number(request.nextUrl.searchParams.get("page"))
  const page = Number.isInteger(n) && n >= 1 ? Math.min(n, 100000) : 1
  try {
    return NextResponse.json({ success: true, data: await listLedger(auth.account.id, page) })
  } catch (e) {
    console.error("[SMS-LEDGER] Error:", e)
    return NextResponse.json({ success: false, error: "Couldn't load credit history, try again." }, { status: 500 })
  }
}
