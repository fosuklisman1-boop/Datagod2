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

        const { channels, recipients, message, subject } = await req.json()

        if (!channels || !recipients || !message) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
        }

        let targetUsers: any[] = []

        if (recipients.type === "roles") {
            const { data, error } = await supabase
                .from("users")
                .select("id, email, phone_number, first_name")
                .in("role", recipients.roles)

            if (error) throw error
            targetUsers = data || []
        } else if (recipients.type === "specific") {
            const { data, error } = await supabase
                .from("users")
                .select("id, email, phone_number, first_name")
                .in("id", recipients.userIds)

            if (error) throw error
            targetUsers = data || []
        }

        if (targetUsers.length === 0) {
            return NextResponse.json({ error: "No recipients found" }, { status: 404 })
        }

        // Create initial broadcast log
        const { data: broadcastLog, error: logError } = await supabase
            .from("broadcast_logs")
            .insert({
                admin_id: caller.id,
                channels: channels,
                target_type: recipients.type,
                target_group: recipients.type === "roles" ? recipients.roles : null,
                subject: subject,
                message: message,
                status: "processing"
            })
            .select()
            .single()

        if (logError) {
            console.error("[BROADCAST-API] Log creation error:", logError)
            // Continue even if logging fails, but we won't have the ID for following logs
        }

        const results = {
            total: targetUsers.length,
            sms: { sent: 0, failed: 0 },
            email: { sent: 0, failed: 0 }
        }

        // Process in small batches to avoid timeouts and rate limits
        const batchSize = 10
        for (let i = 0; i < targetUsers.length; i += batchSize) {
            const batch = targetUsers.slice(i, i + batchSize)

            await Promise.all(batch.map(async (user) => {
                if (channels.includes("sms") && user.phone_number) {
                    try {
                        const res = await sendSMS({
                            phone: user.phone_number,
                            message: message,
                            type: "broadcast",
                            userId: user.id,
                            reference: broadcastLog?.id
                        })
                        if (res.success) results.sms.sent++
                        else results.sms.failed++
                    } catch (e) {
                        results.sms.failed++
                    }
                }

                if (channels.includes("email") && user.email) {
                    try {
                        const emailData = EmailTemplates.broadcastMessage(subject || "Notification from DataGod", message)

                        const res = await sendEmail({
                            to: [{ email: user.email, name: user.first_name || "User" }],
                            subject: emailData.subject,
                            htmlContent: emailData.html,
                            userId: user.id,
                            type: "broadcast",
                            referenceId: broadcastLog?.id
                        })
                        if (res.success) results.email.sent++
                        else results.email.failed++
                    } catch (e) {
                        results.email.failed++
                    }
                }
            }))
        }

        // Update broadcast log with results
        if (broadcastLog) {
            await supabase
                .from("broadcast_logs")
                .update({
                    results: results,
                    status: "completed"
                })
                .eq("id", broadcastLog.id)
        }

        return NextResponse.json({ success: true, results })

    } catch (error: any) {
        console.error("[BROADCAST-API] Error:", error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}
