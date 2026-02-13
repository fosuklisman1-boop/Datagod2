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

        const { broadcastId, limit = 50 } = await req.json()

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

        // Count total failed first to know if we have more
        const { count: failedEmailCount } = await supabase
            .from("email_logs")
            .select("id", { count: 'exact', head: true })
            .eq("reference_id", broadcastId)
            .eq("status", "failed")

        const { count: failedSmsCount } = await supabase
            .from("sms_logs")
            .select("id", { count: 'exact', head: true })
            .eq("reference_id", broadcastId)
            .eq("status", "failed")

        const totalFailedStart = (failedEmailCount || 0) + (failedSmsCount || 0)

        // Fetch FAILED email logs for this broadcast (LIMITED)
        const { data: failedEmails, error: emailError } = await supabase
            .from("email_logs")
            .select("*, user:users!user_id(id, first_name, email)")
            .eq("reference_id", broadcastId)
            .eq("status", "failed")
            .limit(limit)

        let processedCount = 0

        if (failedEmails && failedEmails.length > 0) {
            console.log(`[RETRY] Found ${failedEmails.length} failed emails to retry (limit: ${limit}).`)

            // Deduplication and "Already Sent" check
            const uniqueUsers = new Map<string, any[]>()
            const userIds = new Set<string>()

            failedEmails.forEach(log => {
                if (log.user?.id) {
                    if (!uniqueUsers.has(log.user.id)) {
                        uniqueUsers.set(log.user.id, [])
                        userIds.add(log.user.id)
                    }
                    uniqueUsers.get(log.user.id)?.push(log)
                }
            })

            // Check if these users ALREADY have a 'sent' log for this broadcast
            const { data: alreadySentLogs } = await supabase
                .from("email_logs")
                .select("user_id")
                .eq("reference_id", broadcastId)
                .eq("status", "sent")
                .in("user_id", Array.from(userIds))

            const sentUserIds = new Set(alreadySentLogs?.map(l => l.user_id) || [])

            // Convert map to array for processing
            const usersToProcess = Array.from(uniqueUsers.entries())

            const batchSize = 5
            for (let i = 0; i < usersToProcess.length; i += batchSize) {
                const batch = usersToProcess.slice(i, i + batchSize)

                // Rate limiting delay
                if (i > 0) await new Promise(r => setTimeout(r, 1000))

                await Promise.all(batch.map(async ([userId, logs]) => {
                    const primaryLog = logs[0]
                    processedCount += logs.length

                    // If already sent, just update these failed logs to sent and skip valid send
                    if (sentUserIds.has(userId)) {
                        console.log(`[RETRY] User ${userId} already has sent log. Skipping send.`)
                        await supabase
                            .from("email_logs")
                            .update({ status: "sent", sent_at: new Date().toISOString(), error_message: null })
                            .in("id", logs.map(l => l.id))

                        results.email.sent += logs.length
                        results.email.failed = Math.max(0, results.email.failed - logs.length)
                        retriedCount += logs.length
                        return
                    }

                    if (!primaryLog.user?.email) return

                    try {
                        const emailData = EmailTemplates.broadcastMessage(broadcastLog.subject || "Notification from DataGod", broadcastLog.message)

                        const res = await sendEmail({
                            to: [{ email: primaryLog.user.email, name: primaryLog.user.first_name || "User" }],
                            subject: emailData.subject,
                            htmlContent: emailData.html,
                            userId: userId,
                            type: "broadcast",
                            referenceId: broadcastId
                        })

                        if (res.success) {
                            retriedCount += logs.length
                            results.email.sent += logs.length
                            results.email.failed = Math.max(0, results.email.failed - logs.length)

                            // Update ALL failed logs for this user to success
                            await supabase
                                .from("email_logs")
                                .update({ status: "sent", sent_at: new Date().toISOString(), error_message: null })
                                .in("id", logs.map(l => l.id))
                        }
                    } catch (e) {
                        console.error(`[RETRY] Failed to resend email to ${primaryLog.user.email}:`, e)
                    }
                }))
            }
        }

        // If we haven't hit the limit with emails, check SMS
        // Note: This simple logic prioritizes emails. If emails take up the whole limit, SMS waits for next batch.
        const remainingLimit = limit - processedCount

        if (remainingLimit > 0) {
            // Fetch FAILED SMS logs for this broadcast
            const { data: failedSMS, error: smsError } = await supabase
                .from("sms_logs")
                .select("*, user:users!user_id(id, first_name, phone_number)")
                .eq("reference_id", broadcastId)
                .eq("status", "failed")
                .limit(remainingLimit)

            if (failedSMS && failedSMS.length > 0) {
                console.log(`[RETRY] Found ${failedSMS.length} failed SMS to retry.`)

                const batchSize = 10
                for (let i = 0; i < failedSMS.length; i += batchSize) {
                    const batch = failedSMS.slice(i, i + batchSize)

                    // Rate limiting delay
                    if (i > 0) await new Promise(r => setTimeout(r, 1000))

                    await Promise.all(batch.map(async (log) => {
                        processedCount++
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
        }

        // Update the main broadcast log with new stats
        const { error: updateError } = await supabase
            .from("broadcast_logs")
            .update({ results: results })
            .eq("id", broadcastId)

        if (updateError) {
            console.error("[RETRY] Failed to update broadcast stats:", updateError)
        }

        const remainingCount = Math.max(0, totalFailedStart - processedCount)

        return NextResponse.json({
            success: true,
            retriedCount,
            results,
            processedCount,
            remainingCount,
            hasMore: remainingCount > 0
        })

    } catch (error: any) {
        console.error("[RETRY] API Error:", error)
        return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 })
    }
}
