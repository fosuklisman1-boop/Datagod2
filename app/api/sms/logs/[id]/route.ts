import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { getOrCreateAccountForUser } from "@/lib/sms/account-service"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// GET /api/sms/logs/[id] — one send batch + its per-recipient rows (scoped to the
// caller's account). Powers the History detail modal.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7))
  if (error || !user) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })

  const account = await getOrCreateAccountForUser(user.id)
  if (!account) return NextResponse.json({ success: false, error: "No SMS account for this user" }, { status: 403 })

  const { id } = await params
  const logId = Number(id)
  if (!Number.isFinite(logId)) {
    return NextResponse.json({ success: false, error: "Invalid id" }, { status: 400 })
  }

  // Scope by account so a tenant can only open their own batches.
  const { data: log } = await supabaseAdmin
    .from("sms_send_logs")
    .select("id, status, message, sender_id, recipients_count, segments, credits_reserved, credits_used, created_at, completed_at")
    .eq("id", logId)
    .eq("sms_account_id", account.id)
    .maybeSingle()

  if (!log) return NextResponse.json({ success: false, error: "Batch not found" }, { status: 404 })

  const { data: messages } = await supabaseAdmin
    .from("sms_messages")
    .select("id, phone, status, attempts, last_error, processed_at")
    .eq("send_log_id", logId)
    .order("created_at", { ascending: true })

  return NextResponse.json({ success: true, data: { log, messages: messages ?? [] } })
}
