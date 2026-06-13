import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { enqueueRecipients, drainBroadcasts } from "@/lib/broadcast-drain"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Recipients are persisted to broadcast_recipients up front and drained
// server-side (init kicks the first batch; the drain-broadcasts cron finishes
// the rest). This is what lets a broadcast survive the admin closing their tab —
// the send loop is no longer client-driven.
export async function POST(req: NextRequest) {
    const { isAdmin, userId: callerId, errorResponse } = await verifyAdminAccess(req)
    if (!isAdmin) return errorResponse

    try {
        const supabase = createClient(supabaseUrl, serviceRoleKey)
        const body = await req.json()
        const { action = "legacy" } = body

        // --- ACTION: INIT (create the broadcast, enqueue recipients, send first batch) ---
        if (action === "init") {
            const { channels, recipients, subject, message } = body
            // recipients: { type: 'roles'|'specific', roles?: string[], users?: [{id,email,phone,name}] }

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
            if (!Array.isArray(channels) || channels.length === 0) {
                return NextResponse.json({ error: "at least one channel is required" }, { status: 400 })
            }
            if (!recipients || typeof recipients !== "object") {
                return NextResponse.json({ error: "recipients is required" }, { status: 400 })
            }
            if (recipients.type !== "roles" && recipients.type !== "specific") {
                return NextResponse.json({ error: "recipients.type must be 'roles' or 'specific'" }, { status: 400 })
            }
            if (recipients.type === "specific" && (!Array.isArray(recipients.users) || recipients.users.length === 0)) {
                return NextResponse.json({ error: "recipients.users is required for specific targeting" }, { status: 400 })
            }
            if (recipients.type === "specific" && recipients.users.length > 5000) {
                return NextResponse.json({ error: "cannot target more than 5000 specific users at once" }, { status: 400 })
            }
            if (recipients.type === "roles" && (!Array.isArray(recipients.roles) || recipients.roles.length === 0)) {
                return NextResponse.json({ error: "recipients.roles is required for role targeting" }, { status: 400 })
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
                        total: 0,
                        sms: { sent: 0, failed: 0, pending: 0 },
                        email: { sent: 0, failed: 0, pending: 0 },
                        push: { sent: 0, failed: 0 },
                        whatsapp: { sent: 0, failed: 0 },
                    },
                })
                .select()
                .single()

            if (logError) throw logError

            const broadcastId = broadcastLog.id

            // Persist the full recipient list so the cron can finish the send.
            const enqueued = await enqueueRecipients(supabase, broadcastId, {
                targetType: recipients.type,
                roles: recipients.roles,
                specificUsers: recipients.users,
            })

            if (enqueued === 0) {
                await supabase.from("broadcast_logs").update({ status: "completed" }).eq("id", broadcastId)
                return NextResponse.json({ error: "No recipients matched the selected criteria" }, { status: 400 })
            }

            // Set the real total, then send the first batch synchronously so the
            // admin sees immediate progress. Anything left over is handled by the
            // drain-broadcasts cron — including if the tab closes right now.
            await supabase.rpc("recompute_broadcast_results", { bid: broadcastId, max_attempts: 3 })
            await drainBroadcasts(supabase, { broadcastId, maxRecipients: 30 }).catch((e) => {
                console.error("[BROADCAST-API] first drain failed (cron will retry):", e)
            })

            return NextResponse.json({ success: true, broadcastId, total: enqueued })
        }

        return NextResponse.json({ error: "Invalid action. Please refresh the page." }, { status: 400 })
    } catch (error: any) {
        console.error("[BROADCAST-API] Error:", error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}
