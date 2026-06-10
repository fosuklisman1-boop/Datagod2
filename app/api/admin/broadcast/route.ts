import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { sendSMS } from "@/lib/sms-service"
import { sendEmail, EmailTemplates } from "@/lib/email-service"
import { sendPushToUser } from "@/lib/push-service"
import { sendWhatsAppText } from "@/lib/whatsapp-bot/send"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function POST(req: NextRequest) {
    const { isAdmin, userId: callerId, errorResponse } = await verifyAdminAccess(req)
    if (!isAdmin) return errorResponse

    try {
        const supabase = createClient(supabaseUrl, serviceRoleKey)
        const body = await req.json()
        const { action = "legacy" } = body

        // --- ACTION: INIT (Start a new broadcast) ---
        if (action === "init") {
            const { channels, recipients, subject, message, targetDescription } = body

            // Subject is only required for channels that actually use it (email
            // subject line, push notification title). SMS and WhatsApp don't —
            // so the UI hides the subject for them, and the API must match.
            const subjectRequired = Array.isArray(channels) && (channels.includes("email") || channels.includes("push"))
            if (subjectRequired && (!subject || typeof subject !== "string" || subject.trim().length === 0)) {
              return NextResponse.json({ error: "subject is required for email/push channels" }, { status: 400 })
            }
            if (typeof subject === "string" && subject.length > 200) {
              return NextResponse.json({ error: "subject must be 200 characters or fewer" }, { status: 400 })
            }
            if (!message || typeof message !== "string" || message.trim().length === 0) {
              return NextResponse.json({ error: "message is required" }, { status: 400 })
            }
            if (message.length > 5000) {
              return NextResponse.json({ error: "message must be 5000 characters or fewer" }, { status: 400 })
            }
            if (!recipients || typeof recipients !== "object") {
              return NextResponse.json({ error: "recipients is required" }, { status: 400 })
            }

            const { data: broadcastLog, error: logError } = await supabase
                .from("broadcast_logs")
                .insert({
                    admin_id: callerId,
                    channels: channels,
                    target_type: recipients.type,
                    target_group: recipients.roles || ["specific"],
                    subject: (typeof subject === "string" ? subject : ""),
                    message: message,
                    status: "processing",
                    results: {
                        total: body.estimatedCount || 0,
                        sms: { sent: 0, failed: 0, pending: 0 },
                        email: { sent: 0, failed: 0, pending: 0 },
                        whatsapp: { sent: 0, failed: 0, pending: 0 },
                    }
                })
                .select()
                .single()

            if (logError) throw logError

            return NextResponse.json({ success: true, broadcastId: broadcastLog.id })
        }

        // --- ACTION: BATCH (Send a chunk of messages) ---
        if (action === "batch") {
            const { broadcastId, recipients, channels, subject, message } = body
            // recipients: array of { id, email, phone, name }

            if (!Array.isArray(recipients)) {
              return NextResponse.json({ error: "recipients must be an array" }, { status: 400 })
            }
            if (recipients.length > 1000) {
              return NextResponse.json({ error: "recipients batch cannot exceed 1000 items" }, { status: 400 })
            }
            if (message && message.length > 5000) {
              return NextResponse.json({ error: "message must be 5000 characters or fewer" }, { status: 400 })
            }

            const batchResults = {
                sms: { sent: 0, failed: 0 },
                email: { sent: 0, failed: 0 },
                push: { sent: 0, failed: 0, skipped: 0 },
                whatsapp: { sent: 0, failed: 0 },
            }

            await Promise.all(recipients.map(async (user: any) => {
                // SMS
                if (channels.includes("sms") && user.phone) {
                    try {
                        const res = await sendSMS({
                            phone: user.phone,
                            message: message,
                            type: "broadcast",
                            userId: user.id,
                            reference: broadcastId
                        })
                        if (res.success) batchResults.sms.sent++
                        else batchResults.sms.failed++
                    } catch (e) {
                        batchResults.sms.failed++
                    }
                }

                // Email
                if (channels.includes("email") && user.email) {
                    try {
                        const emailData = EmailTemplates.broadcastMessage(subject || "Notification", message)
                        const res = await sendEmail({
                            to: [{ email: user.email, name: user.name || "User" }],
                            subject: emailData.subject,
                            htmlContent: emailData.html,
                            userId: user.id,
                            type: "broadcast",
                            referenceId: broadcastId
                        })
                        if (res.success) batchResults.email.sent++
                        else batchResults.email.failed++
                    } catch (e) {
                        batchResults.email.failed++
                    }
                }

                // Push
                if (channels.includes("push") && user.id) {
                    try {
                        const { sent, removed } = await sendPushToUser(user.id, {
                            title: subject || "Notification",
                            body: message,
                            data: { url: "/dashboard" },
                        })
                        if (sent > 0) batchResults.push.sent++
                        else if (removed > 0) batchResults.push.failed++ // expired subscriptions
                        else batchResults.push.skipped++ // not subscribed
                    } catch (e) {
                        batchResults.push.failed++
                    }
                }

                // WhatsApp (Cloud API). Free-form text only reaches users inside
                // the 24h customer-service window; others fail unless a template
                // is used. sendWhatsAppText returns false (never throws) on failure.
                if (channels.includes("whatsapp") && user.phone) {
                    try {
                        const raw = String(user.phone).replace(/\s/g, "")
                        const waPhone = raw.startsWith("0")
                            ? `233${raw.slice(1)}`
                            : raw.replace(/^\+/, "")
                        const ok = await sendWhatsAppText(waPhone, message)
                        if (ok) batchResults.whatsapp.sent++
                        else batchResults.whatsapp.failed++
                    } catch (e) {
                        batchResults.whatsapp.failed++
                    }
                }

            }))

            return NextResponse.json({ success: true, results: batchResults })
        }

        // --- ACTION: FINALIZE (Update final stats) ---
        if (action === "finalize") {
            const { broadcastId, whatsapp } = body
            // WhatsApp isn't written to a *_logs table keyed by reference, so its
            // totals can't be re-aggregated here — the client passes the live counts.
            const whatsappStats = {
                sent: Number(whatsapp?.sent) || 0,
                failed: Number(whatsapp?.failed) || 0,
            }

            // Aggregate actual logs to get truth
            const [emailSent, emailFailed, emailPending, smsSent, smsFailed, smsPending] = await Promise.all([
                supabase.from("email_logs").select("id", { count: 'exact', head: true }).eq("reference_id", broadcastId).or('status.eq.sent,status.eq.delivered'),
                supabase.from("email_logs").select("id", { count: 'exact', head: true }).eq("reference_id", broadcastId).eq("status", "failed"),
                supabase.from("email_logs").select("id", { count: 'exact', head: true }).eq("reference_id", broadcastId).eq("status", "pending"),
                supabase.from("sms_logs").select("id", { count: 'exact', head: true }).eq("reference_id", broadcastId).or('status.eq.sent,status.eq.delivered'),
                supabase.from("sms_logs").select("id", { count: 'exact', head: true }).eq("reference_id", broadcastId).eq("status", "failed"),
                supabase.from("sms_logs").select("id", { count: 'exact', head: true }).eq("reference_id", broadcastId).eq("status", "pending")
            ])

            const finalResults = {
                total: (emailSent.count || 0) + (emailFailed.count || 0) + (emailPending.count || 0) + (smsSent.count || 0) + (smsFailed.count || 0) + (smsPending.count || 0) + whatsappStats.sent + whatsappStats.failed, // Approx
                email: {
                    sent: emailSent.count || 0,
                    failed: emailFailed.count || 0,
                    pending: emailPending.count || 0
                },
                sms: {
                    sent: smsSent.count || 0,
                    failed: smsFailed.count || 0,
                    pending: smsPending.count || 0
                },
                whatsapp: {
                    sent: whatsappStats.sent,
                    failed: whatsappStats.failed,
                    pending: 0
                }
            }

            await supabase
                .from("broadcast_logs")
                .update({
                    results: finalResults,
                    status: "completed"
                })
                .eq("id", broadcastId)

            return NextResponse.json({ success: true, results: finalResults })
        }

        // --- LEGACY FALLBACK (Keep for backward compatibility during deploy) ---
        return NextResponse.json({ error: "Invalid action. Please refresh the page." }, { status: 400 })

    } catch (error: any) {
        console.error("[BROADCAST-API] Error:", error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}
