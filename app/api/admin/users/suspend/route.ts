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
    const banDuration = isSuspending ? "876000h" : "none"
    const { error: authError } = await adminClient.auth.admin.updateUserById(userId, {
      ban_duration: banDuration,
    })

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
        error: `Auth suspended, but database update failed: ${dbError.message}`
      }, { status: 500 })
    }

    // 4. Send Notifications (Fire and forget or wait - let's wait to ensure user knows it's sent)
    const notificationResults = { sms: false, email: false }

    try {
      if (isSuspending) {
        // Send Suspension Notifications
        if (userData.phone_number) {
          const { sendSMS, SMSTemplates } = await import("@/lib/sms-service")
          await sendSMS({
            phone: userData.phone_number,
            message: SMSTemplates.userSuspended(reason),
            type: "user_suspension",
            userId: userId
          })
          notificationResults.sms = true
        }

        if (userData.email) {
          const { sendEmail, EmailTemplates } = await import("@/lib/email-service")
          const payload = EmailTemplates.userSuspended(userData.email, reason)
          await sendEmail({
            to: [{ email: userData.email, name: userData.first_name || "User" }],
            subject: payload.subject,
            htmlContent: payload.html,
            type: "user_suspension",
            userId: userId
          })
          notificationResults.email = true
        }
      } else {
        // Send Restoration Notifications
        if (userData.phone_number) {
          const { sendSMS, SMSTemplates } = await import("@/lib/sms-service")
          await sendSMS({
            phone: userData.phone_number,
            message: SMSTemplates.userUnsuspended(),
            type: "user_restoration",
            userId: userId
          })
          notificationResults.sms = true
        }

        if (userData.email) {
          const { sendEmail, EmailTemplates } = await import("@/lib/email-service")
          const payload = EmailTemplates.userUnsuspended(userData.email)
          await sendEmail({
            to: [{ email: userData.email, name: userData.first_name || "User" }],
            subject: payload.subject,
            htmlContent: payload.html,
            type: "user_restoration",
            userId: userId
          })
          notificationResults.email = true
        }
      }
    } catch (notifErr) {
      console.warn("[ADMIN-SUSPEND-USER] Notification error (non-fatal):", notifErr)
    }

    console.log(`[ADMIN-SUSPEND-USER] Successfully executed ${action} for user ${userId}. Notifications:`, notificationResults)

    return NextResponse.json({
      success: true,
      message: `User successfully ${isSuspending ? "suspended" : "unsuspended"}`,
      action,
      notifications: notificationResults
    })

  } catch (error: any) {
    console.error("[ADMIN-SUSPEND-USER] Fatal error:", error)
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 })
  }
}
