import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { resolveAccount } from "@/lib/sms/tenant-auth"
import { listRecords } from "@/lib/sms/customer-reads"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * Return sms_send_logs for the authenticated user's SMS account.
 * Without ?status= / ?page= : latest 30 entries, newest first (legacy shape, used by the old page).
 * With either param: paged (25/page) and filterable; data adds { total, page, pageSize }.
 */
export async function GET(request: NextRequest) {
  const auth = await resolveAccount(request)
  if (auth.error) return auth.error
  const { account } = auth

  const params = request.nextUrl.searchParams
  const statusParam = params.get("status")
  const pageParam = params.get("page")

  if (statusParam !== null || pageParam !== null) {
    const n = Number(pageParam)
    const page = Number.isInteger(n) && n >= 1 ? Math.min(n, 100000) : 1
    try {
      const r = await listRecords(account.id, { status: statusParam ?? "", page })
      return NextResponse.json({ success: true, data: { logs: r.rows, total: r.total, page: r.page, pageSize: r.pageSize } })
    } catch (e) {
      console.error("[SMS-LOGS] Fetch error:", e)
      return NextResponse.json({ success: false, error: "Failed to fetch logs" }, { status: 500 })
    }
  }

  const { data: logs, error: logsError } = await supabaseAdmin
    .from("sms_send_logs")
    .select("id, status, message, sender_id, recipients_count, segments, credits_reserved, credits_used, created_at, completed_at")
    .eq("sms_account_id", account.id)
    .order("created_at", { ascending: false })
    .limit(30)

  if (logsError) {
    console.error("[SMS-LOGS] Fetch error:", logsError)
    return NextResponse.json({ success: false, error: "Failed to fetch logs" }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: { logs: logs ?? [] } })
}
