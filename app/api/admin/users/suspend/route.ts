import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { gateAdmin } from "@/lib/admin-users/route-utils"
import { isUuid } from "@/lib/admin-users/drawer-params"
import { sendPushToUser } from "@/lib/push-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function POST(req: NextRequest) {
  try {
    // 1. Verify admin access, honouring every gate error including the rate limit (429). write: false keeps the
    // CRON bypass working here: the AI scheduled tasks and WhatsApp admin bot suspend users through this route.
    // Those calls have no admin id, so they are not audited (admin_audit_log.admin_id is NOT NULL).
    const gate = await gateAdmin(req, { write: false })
    if (!gate.ok) return gate.response
    const adminId = gate.adminId

    const { userId, action, reason } = await req.json()

    if (!isUuid(userId) || !["suspend", "unsuspend"].includes(action)) {
      return NextResponse.json(
        { error: "Valid User ID and action (suspend/unsuspend) are required" },
        { status: 400 }
      )
    }

    // Create admin client with service role
    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })

    const isSuspending = action === "suspend"
    console.log(`[ADMIN-SUSPEND-USER] Admin is attempting to ${action} user ${userId}...`)

    // Fetch user details for notifications
    const { data: userData, error: userError } = await adminClient
      .from("users")
      .select("email, phone_number, first_name")
      .eq("id", userId)
      .single()

    if (userError || !userData) {
      console.error("[ADMIN-SUSPEND-USER] Failed to fetch user data:", userError)
      return NextResponse.json({ error: "User not found in profile table" }, { status: 404 })
    }

    // 2. Update Supabase Auth (Ban or Unban)
    // To lift a ban, ban_duration should be set to "none" or null.
    // Based on community findings, null is the most effective in clearing banned_until.
    const banDuration = isSuspending ? "876000h" : "none" as any // Try 'none' first as per some SDKs, or null
    
    // We'll try dynamic value based on action
    const attributes: any = {
      ban_duration: isSuspending ? "876000h" : null 
    }

    const { error: authError } = await adminClient.auth.admin.updateUserById(userId, attributes)

    if (authError) {
      console.error("[ADMIN-SUSPEND-USER] Auth update error:", authError)
      return NextResponse.json({
        error: `Supabase Auth update failed: ${authError.message}`
      }, { status: 400 })
    }

    // 3. Update public.users table status flag for the UI
    const { error: dbError } = await adminClient
      .from("users")
      .update({
        is_suspended: isSuspending,
        updated_at: new Date().toISOString()
      })
      .eq("id", userId)

    if (dbError) {
      console.error("[ADMIN-SUSPEND-USER] Database update error:", dbError)
      return NextResponse.json({
        error: `Auth updated, but database flag failed: ${dbError.message}`
      }, { status: 500 })
    }

    // Audit trail, with the reason (the admin user drawer shows the latest suspension's reason). The CRON
    // bypass has no admin id and admin_audit_log.admin_id is NOT NULL, so it is not audited. Best-effort.
    if (adminId) {
      const { error: auditError } = await adminClient.from("admin_audit_log").insert([{
        admin_id: adminId,
        action: isSuspending ? "user_suspend" : "user_unsuspend",
        target_user_id: userId,
        old_value: { is_suspended: !isSuspending },
        new_value: { is_suspended: isSuspending, reason: typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 500) : null },
      }])
      if (auditError) console.warn("[ADMIN-SUSPEND-USER] audit insert failed:", auditError.message)
    }

    // 4. Send Notifications
    const notificationResults: any = { sms: false, email: false, sms_error: null, email_error: null }

    try {
      console.log(`[ADMIN-SUSPEND-USER] Sending notifications for ${action}...`)
      if (isSuspending) {
        // Send Suspension Notifications
        if (userData.phone_number) {
          const { sendSMS, SMSTemplates } = await import("@/lib/sms-service")
          console.log(`[ADMIN-SUSPEND-USER] Attempting SMS to ${userData.phone_number}`)
          const smsRes = await sendSMS({
            phone: userData.phone_number,
            message: SMSTemplates.userSuspended(reason),
            type: "user_suspension",
            userId: userId
          })
          notificationResults.sms = smsRes.success
          if (!smsRes.success) {
            notificationResults.sms_error = smsRes.error || "Unknown SMS error"
            console.warn(`[ADMIN-SUSPEND-USER] SMS failed: ${smsRes.error}`)
          } else {
            console.log(`[ADMIN-SUSPEND-USER] SMS sent successfully`)
          }
        }

        if (userData.email) {
          const { sendEmail, EmailTemplates } = await import("@/lib/email-service")
          console.log(`[ADMIN-SUSPEND-USER] Attempting Email to ${userData.email}`)
          const payload = EmailTemplates.userSuspended(userData.email, reason)
          const emailRes = await sendEmail({
            to: [{ email: userData.email, name: userData.first_name || "User" }],
            subject: payload.subject,
            htmlContent: payload.html,
            type: "user_suspension",
            userId: userId
          })
          notificationResults.email = emailRes.success
          if (!emailRes.success) {
            notificationResults.email_error = emailRes.error || "Unknown Email error"
            console.warn(`[ADMIN-SUSPEND-USER] Email failed: ${emailRes.error}`)
          } else {
            console.log(`[ADMIN-SUSPEND-USER] Email sent successfully`)
          }
        }
      } else {
        // Send Restoration Notifications
        if (userData.phone_number) {
          const { sendSMS, SMSTemplates } = await import("@/lib/sms-service")
          const smsRes = await sendSMS({
            phone: userData.phone_number,
            message: SMSTemplates.userUnsuspended(),
            type: "user_restoration",
            userId: userId
          })
          notificationResults.sms = smsRes.success
          if (!smsRes.success) notificationResults.sms_error = smsRes.error || "Unknown SMS error"
        }

        if (userData.email) {
          const { sendEmail, EmailTemplates } = await import("@/lib/email-service")
          const payload = EmailTemplates.userUnsuspended(userData.email)
          const emailRes = await sendEmail({
            to: [{ email: userData.email, name: userData.first_name || "User" }],
            subject: payload.subject,
            htmlContent: payload.html,
            type: "user_restoration",
            userId: userId
          })
          notificationResults.email = emailRes.success
          if (!emailRes.success) notificationResults.email_error = emailRes.error || "Unknown Email error"
        }
      }
      // Push to user (device receives it regardless of auth ban state)
      sendPushToUser(userId, {
        title: isSuspending ? '⚠️ Account Suspended' : '✅ Account Restored',
        body: isSuspending
          ? `Your account has been suspended${reason ? ': ' + reason : ''}. Contact support to appeal.`
          : 'Your account has been restored. You can now log in again.',
        data: { url: '/' },
      }).catch(() => {})
    } catch (notifErr: any) {
      console.warn("[ADMIN-SUSPEND-USER] Notification error (non-fatal):", notifErr)
      notificationResults.sms_error = notifErr.message
    }

    const envDiagnostics = {
      SMS_ENABLED: process.env.SMS_ENABLED === "true",
      SMS_PROVIDER: process.env.SMS_PROVIDER || "moolre",
      HAS_SENDER_ID: !!(process.env.MOOLRE_SENDER_ID || process.env.MNOTIFY_SENDER_ID || process.env.BREVO_SMS_SENDER),
    }

    return NextResponse.json({
      success: true,
      message: `User successfully ${isSuspending ? "suspended" : "unsuspended"}`,
      action,
      notifications: notificationResults,
      diagnostics: envDiagnostics
    })

  } catch (error: any) {
    console.error("[ADMIN-SUSPEND-USER] Fatal error:", error)
    return NextResponse.json({ 
      error: error.message || "Internal server error" ,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined
    }, { status: 500 })
  }
}
