import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { sendPushToUser } from "@/lib/push-service"
import { sendSMS } from "@/lib/sms-service"
import { sendEmail } from "@/lib/email-service"
import { sendWhatsAppNotification } from "@/lib/whatsapp-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const body = await request.json()
    const { target, user_id, channels = ["push"], title, body: msgBody, email_html } = body

    if (!target || !title || !msgBody) {
      return NextResponse.json({ error: "target, title, and body are required" }, { status: 400 })
    }

    // Resolve the list of target users
    let targetUsers: { id: string; email?: string | null; phone_number?: string | null }[] = []

    if (target === "specific_user") {
      if (!user_id) return NextResponse.json({ error: "user_id is required for specific_user target" }, { status: 400 })
      const { data } = await supabase
        .from("users")
        .select("id, email, phone_number")
        .eq("id", user_id)
        .maybeSingle()
      if (data) targetUsers = [data]
    } else {
      const roleMap: Record<string, string> = {
        all_dealers: "dealer",
        all_users: "user",
        all_admins: "admin",
      }
      const role = roleMap[target]
      if (!role) return NextResponse.json({ error: "Invalid target" }, { status: 400 })
      const { data } = await supabase
        .from("users")
        .select("id, email, phone_number")
        .eq("role", role)
      targetUsers = data ?? []
    }

    if (!targetUsers.length) {
      return NextResponse.json({ pushed: 0, smsed: 0, emailed: 0, message: "No users found for target" })
    }

    let pushed = 0
    let smsed = 0
    let whatsapped = 0
    let emailed = 0
    const errors: string[] = []

    for (const user of targetUsers) {
      if (channels.includes("push")) {
        try {
          const result = await sendPushToUser(user.id, { title, body: msgBody })
          pushed += result.sent
        } catch (e) {
          errors.push(`push:${user.id}: ${e}`)
        }
      }

      if (channels.includes("sms") && user.phone_number) {
        try {
          const result = await sendSMS({
            phone: user.phone_number,
            message: `${title}: ${msgBody}`.slice(0, 160),
            type: "admin_notification",
            userId: user.id,
            skipLogging: true,
          })
          if (result.success) smsed++
        } catch (e) {
          errors.push(`sms:${user.id}: ${e}`)
        }
      }

      if (channels.includes("whatsapp") && user.phone_number) {
        try {
          const result = await sendWhatsAppNotification({
            phone: user.phone_number,
            title,
            body: msgBody,
            reference: "admin_notification",
            userId: user.id,
          })
          if (result.success) whatsapped++
          else errors.push(`whatsapp:${user.id}: ${result.error}`)
        } catch (e) {
          errors.push(`whatsapp:${user.id}: ${e}`)
        }
      }

      if (channels.includes("email") && user.email) {
        try {
          const result = await sendEmail({
            to: [{ email: user.email }],
            subject: title,
            htmlContent: email_html ?? `<p>${msgBody}</p>`,
            textContent: msgBody,
            type: "admin_notification",
            userId: user.id,
            skipLogging: true,
          })
          if (result.success) emailed++
        } catch (e) {
          errors.push(`email:${user.id}: ${e}`)
        }
      }
    }

    return NextResponse.json({
      pushed,
      smsed,
      whatsapped,
      emailed,
      total_users: targetUsers.length,
      errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
    })
  } catch (err) {
    console.error("[ADMIN-NOTIFY] Error:", err)
    return NextResponse.json({ error: "Notification failed" }, { status: 500 })
  }
}
