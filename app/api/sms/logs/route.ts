import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { getOrCreateAccountForUser } from "@/lib/sms/account-service"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * Return recent sms_send_logs for the authenticated user's SMS account.
 * Latest 30 entries, newest first.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const token = authHeader.slice(7)
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token)
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const account = await getOrCreateAccountForUser(user.id)
  if (!account) {
    return NextResponse.json({ error: "No SMS account for this user" }, { status: 403 })
  }

  const { data: logs, error: logsError } = await supabaseAdmin
    .from("sms_send_logs")
    .select("*")
    .eq("sms_account_id", account.id)
    .order("created_at", { ascending: false })
    .limit(30)

  if (logsError) {
    console.error("[SMS-LOGS] Fetch error:", logsError)
    return NextResponse.json({ error: "Failed to fetch logs" }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: { logs: logs ?? [] } })
}
