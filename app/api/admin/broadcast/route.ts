import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { sendSMS } from "@/lib/sms-service"
import { sendEmail, EmailTemplates } from "@/lib/email-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// ... (imports remain)

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

        const body = await req.json()
        const { action = "legacy" } = body

        // --- ACTION: INIT (Start a new broadcast) ---
        if (action === "init") {
            const { channels, recipients, subject, message, targetDescription } = body

            const { data: broadcastLog, error: logError } = await supabase
                .from("broadcast_logs")
                .insert({
                    admin_id: caller.id,
                    channels: channels,
                    target_type: recipients.type,
                    target_group: recipients.roles || ["specific"],
                    subject: subject,
                    message: message,
                    status: "processing",
                    results: {
                        total: body.estimatedCount || 0,
                        sms: { sent: 0, failed: 0, pending: 0 },
                        email: { sent: 0, failed: 0, pending: 0 }
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

            const batchResults = {
                sms: { sent: 0, failed: 0 },
                email: { sent: 0, failed: 0 }
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
            }))

            return NextResponse.json({ success: true, results: batchResults })
        }

        // --- ACTION: FINALIZE (Update final stats) ---
        if (action === "finalize") {
            const { broadcastId } = body

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
                total: (emailSent.count || 0) + (emailFailed.count || 0) + (emailPending.count || 0) + (smsSent.count || 0) + (smsFailed.count || 0) + (smsPending.count || 0), // Approx
                email: {
                    sent: emailSent.count || 0,
                    failed: emailFailed.count || 0,
                    pending: emailPending.count || 0
                },
                sms: {
                    sent: smsSent.count || 0,
                    failed: smsFailed.count || 0,
                    pending: smsPending.count || 0
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
