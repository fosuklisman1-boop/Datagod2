import { createHash } from "crypto"
import { NextRequest, NextResponse } from "next/server"
import { gateAdmin, serviceClient, userIdParam, writeAudit, type IdCtx } from "@/lib/admin-users/route-utils"
import { createPasswordResetLink, recentResetCount, RESET_MAX_PER_HOUR, RESET_TOKEN_TTL_MINUTES } from "@/lib/password-reset"

export const dynamic = "force-dynamic"

/**
 * POST /api/admin/users/[id]/password-reset
 *
 * Emails the user the app's own reset link, exactly as /auth/forgot-password does: a password_reset_requests
 * token and ${NEXT_PUBLIC_APP_URL}/auth/reset-password?token=... (the page that consumes it), sent with
 * EmailTemplates.passwordReset. (Supabase's resetPasswordForEmail / generateLink('recovery') would send a
 * Supabase recovery link, which /auth/reset-password does not handle.) The same per-account limit applies
 * (3 per hour), but here it is reported as a 429 instead of silently dropped.
 *
 * Audited as 'user_password_reset_sent' (email, expiry, and a sha256 of the token; never the token or link).
 * The link goes to the user's inbox only: it is not returned to the admin or logged. Refuses the CRON bypass.
 * → { success, email, expiresInMinutes, audited }
 */
export async function POST(req: NextRequest, ctx: IdCtx) {
  const gate = await gateAdmin(req, { write: true })
  if (!gate.ok) return gate.response
  const idp = await userIdParam(ctx)
  if (!idp.ok) return idp.response
  const adminId = gate.adminId!

  const db = serviceClient()
  const { data: user, error: userErr } = await db
    .from("users").select("id, email, phone_number, first_name").eq("id", idp.id).maybeSingle()
  if (userErr) return NextResponse.json({ error: "Failed to load user" }, { status: 500 })
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 })
  if (!user.email) return NextResponse.json({ error: "This user has no email address" }, { status: 400 })

  const recent = await recentResetCount(db, user.id)
  if (recent !== null && recent >= RESET_MAX_PER_HOUR) {
    return NextResponse.json({ error: `This account already had ${recent} reset links in the last hour. Try again later.` }, { status: 429 })
  }

  const link = await createPasswordResetLink(db, user)
  if (!link) return NextResponse.json({ error: "Failed to create the reset link" }, { status: 500 })

  const { sendEmail, EmailTemplates } = await import("@/lib/email-service")
  const payload = EmailTemplates.passwordReset(link.url)
  const sent = await sendEmail({
    to: [{ email: user.email, name: user.first_name || "User" }],
    subject: payload.subject,
    htmlContent: payload.html,
    userId: user.id,
    type: "password_reset_link",
  }).catch((e: unknown) => ({ success: false, error: e instanceof Error ? e.message : String(e) }))
  if (!sent.success) {
    console.error("[ADMIN-PASSWORD-RESET] email failed:", sent.error)
    return NextResponse.json({ error: "The reset email could not be sent" }, { status: 502 })
  }

  const audited = await writeAudit(db, {
    admin_id: adminId,
    action: "user_password_reset_sent",
    target_user_id: user.id,
    // Never the token or the link: whoever holds either can reset the password. The hash only lets a
    // row be matched to its password_reset_requests row (sha256 of that row's id).
    new_value: {
      email: user.email,
      expires_in_minutes: RESET_TOKEN_TTL_MINUTES,
      reset_request_sha256: createHash("sha256").update(link.token).digest("hex"),
    },
  })
  return NextResponse.json({ success: true, email: user.email, expiresInMinutes: RESET_TOKEN_TTL_MINUTES, audited })
}
