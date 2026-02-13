import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { sendSMS } from "@/lib/sms-service"
import { sendEmail, EmailTemplates } from "@/lib/email-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function POST(req: NextRequest) {
    try {
        const authHeader = req.headers.get("Authorization")
        if (!authHeader?.startsWith("Bearer ")) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        const token = authHeader.slice(7)
        const supabase = createClient(supabaseUrl, serviceRoleKey)
        const { data: { user: caller }, error: authError } = await supabase.auth.getUser(token)

        if (authError || !caller) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        // Verify admin
        const { data: profile } = await supabase
            .from("users")
            .select("role")
            .eq("id", caller.id)
            .single()

        if (profile?.role !== "admin" && caller.user_metadata?.role !== "admin") {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 })
        }

        const { broadcastId } = await req.json()

        if (!broadcastId) {
            return NextResponse.json({ error: "Missing broadcastId" }, { status: 400 })
        }

        // Fetch the broadcast log
        const { data: broadcastLog, error: logError } = await supabase
            .from("broadcast_logs")
            .select("*")
            .eq("id", broadcastId)
            .single()

        if (logError || !broadcastLog) {
            return NextResponse.json({ error: "Broadcast not found" }, { status: 404 })
        }

        const results = broadcastLog.results || { sms: { sent: 0, failed: 0 }, email: { sent: 0, failed: 0 } }
        let retriedCount = 0

        // Fetch FAILED email logs for this broadcast
        const { data: failedEmails, error: emailError } = await supabase
            .from("email_logs")
            .select("*, user:users!user_id(id, first_name, email)") // Fixed join
            .eq("reference_id", broadcastId)
            .eq("status", "failed")

        if (failedEmails && failedEmails.length > 0) {
            console.log(`[RETRY] Found ${failedEmails.length} failed emails to retry.`)

            // Re-send emails
            const batchSize = 5
            for (let i = 0; i < failedEmails.length; i += batchSize) {
                const batch = failedEmails.slice(i, i + batchSize)

                // Rate limiting delay
                if (i > 0) await new Promise(r => setTimeout(r, 1000))

                await Promise.all(batch.map(async (log) => {
                    if (!log.user?.email) return

                    try {
                        const emailData = EmailTemplates.broadcastMessage(broadcastLog.subject || "Notification from DataGod", broadcastLog.message)

                        const res = await sendEmail({
                            to: [{ email: log.user.email, name: log.user.first_name || "User" }],
                            subject: emailData.subject,
                            htmlContent: emailData.html,
                            userId: log.user.id,
                            type: "broadcast",
                            referenceId: broadcastId
                        })

                        if (res.success) {
                            retriedCount++
                            results.email.sent++
                            results.email.failed = Math.max(0, results.email.failed - 1)

                            // Update this specific log entry to success
                            await supabase
                                .from("email_logs")
                                .update({ status: "sent", sent_at: new Date().toISOString(), error_message: null })
                                .eq("id", log.id)
                        }
                    } catch (e) {
                        console.error(`[RETRY] Failed to resend email to ${log.user.email}:`, e)
                    }
                }))
            }
        }

        // Fetch FAILED SMS logs for this broadcast
        const { data: failedSMS, error: smsError } = await supabase
            .from("sms_logs")
            .select("*, user:users!user_id(id, first_name, phone_number)") // Fixed join
            .eq("reference_id", broadcastId)
            .eq("status", "failed")

        if (failedSMS && failedSMS.length > 0) {
            console.log(`[RETRY] Found ${failedSMS.length} failed SMS to retry.`)

            const batchSize = 10
            for (let i = 0; i < failedSMS.length; i += batchSize) {
                const batch = failedSMS.slice(i, i + batchSize)

                // Rate limiting delay
                if (i > 0) await new Promise(r => setTimeout(r, 1000))

                await Promise.all(batch.map(async (log) => {
                    if (!log.user?.phone_number) return

                    try {
                        const res = await sendSMS({
                            phone: log.user.phone_number,
                            message: broadcastLog.message,
                            type: "broadcast",
                            userId: log.user.id,
                            reference: broadcastId
                        })

                        if (res.success) {
                            retriedCount++
                            results.sms.sent++
                            results.sms.failed = Math.max(0, results.sms.failed - 1)

                            // Update this specific log entry to success
                            await supabase
                                .from("sms_logs")
                                .update({ status: "sent", sent_at: new Date().toISOString(), error_message: null })
                                .eq("id", log.id)
                        }
                    } catch (e) {
                        console.error(`[RETRY] Failed to resend SMS to ${log.user.phone_number}:`, e)
                    }
                }))
            }
        }

        // Update the main broadcast log with new stats
        const { error: updateError } = await supabase
            .from("broadcast_logs")
            .update({ results: results })
            .eq("id", broadcastId)

        if (updateError) {
            console.error("[RETRY] Failed to update broadcast stats:", updateError)
        }

        return NextResponse.json({ success: true, retriedCount, results })

    } catch (error: any) {
        console.error("[RETRY] API Error:", error)
        return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 })
    }
}
