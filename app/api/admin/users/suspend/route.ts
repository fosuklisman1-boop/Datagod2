import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function POST(req: NextRequest) {
  try {
    // 1. Verify admin access
    const { isAdmin, errorResponse } = await verifyAdminAccess(req)
    if (!isAdmin) return errorResponse

    const { userId, action, reason } = await req.json()

    if (!userId || !["suspend", "unsuspend"].includes(action)) {
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
