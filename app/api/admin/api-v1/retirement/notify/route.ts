import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getAdminClient } from "@/lib/api-v2/store"
import { sendSMS } from "@/lib/sms-service"
import { sendEmail } from "@/lib/email-service"
import { sendNotices, type NoticeRecipient } from "@/lib/api-v1/retirement-admin"

export const maxDuration = 300

const NOTICE_TYPE = "api_v1_retirement_notice"

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** POST /api/admin/api-v1/retirement/notify - Admin: SMS + email every user with an active v1 key. */
export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (errorResponse) return errorResponse
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  let confirmResend = false
  try {
    const body = await request.json()
    confirmResend = body?.confirm_resend === true
  } catch {
    // empty body is fine
  }

  const supabase = getAdminClient() as any
  try {
    const { data: cfg, error: cfgErr } = await supabase
      .from("api_v2_config")
      .select("v1_sunset_at, v1_exempt_user_ids, v1_notice_sent_at")
      .eq("id", true)
      .maybeSingle()
    if (cfgErr || !cfg) throw new Error("config read failed")
    if (!cfg.v1_sunset_at) return NextResponse.json({ error: "no_sunset_set" }, { status: 400 })
    if (cfg.v1_notice_sent_at && !confirmResend) {
      return NextResponse.json({ error: "already_sent", sent_at: cfg.v1_notice_sent_at }, { status: 409 })
    }
    const sunsetAt = new Date(cfg.v1_sunset_at)
    const exemptIds: string[] = Array.isArray(cfg.v1_exempt_user_ids) ? cfg.v1_exempt_user_ids : []

    const { data: keys, error: keysErr } = await supabase
      .from("user_api_keys")
      .select("user_id")
      .eq("is_active", true)
      .limit(5000)
    if (keysErr) throw new Error("keys read failed")
    const userIds = Array.from(new Set(((keys ?? []) as any[]).map((k) => k.user_id).filter(Boolean))) as string[]

    const recipients: NoticeRecipient[] = []
    for (let i = 0; i < userIds.length; i += 100) {
      const { data: users, error: uErr } = await supabase
        .from("users")
        .select("id, email, phone_number, first_name")
        .in("id", userIds.slice(i, i + 100))
      if (uErr) throw new Error("users read failed")
      for (const u of (users ?? []) as any[]) {
        recipients.push({ user_id: u.id, email: u.email || null, phone: u.phone_number || null, first_name: u.first_name || null })
      }
    }

    const result = await sendNotices(recipients, exemptIds, sunsetAt, {
      sms: ({ phone, message, userId }) => sendSMS({ phone, message, type: NOTICE_TYPE, userId }),
      email: ({ email, name, subject, text, userId }) =>
        sendEmail({
          to: [{ email, name }],
          subject,
          htmlContent: `<p>${escapeHtml(text)}</p>`,
          textContent: text,
          userId,
          type: NOTICE_TYPE,
        }),
    })

    const { error: stampErr } = await supabase
      .from("api_v2_config")
      .update({ v1_notice_sent_at: new Date().toISOString() })
      .eq("id", true)
    if (stampErr) console.error("[ADMIN API V1] Failed to stamp notice_sent_at")
    console.log(`[ADMIN API V1] Retirement notice: recipients=${recipients.length} sms=${result.sms_sent} email=${result.email_sent} failed=${result.failed}`)
    return NextResponse.json(result)
  } catch (e) {
    console.error("[ADMIN API V1] Retirement notify error:", e instanceof Error ? e.message : "unknown")
    return NextResponse.json({ error: "Failed to send notices" }, { status: 500 })
  }
}
