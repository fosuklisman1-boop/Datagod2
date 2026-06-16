import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { enqueueRecipients, drainBroadcasts } from "@/lib/broadcast-drain"
import { resolveRecipients } from "@/lib/sms/recipients"
import { personalize } from "@/lib/sms/personalize"

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
            // recipients:
            //   { type: 'roles',    roles: string[] }
            //   { type: 'specific', users: [{id,email,phone,name}] }
            //   { type: 'group',    groupId: string }   ← address-book group (M5)
            // Optional (group): mergeFields:boolean (default true) personalises
            // [FirstName]/[LastName]/[Phone] per recipient.

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
            if (recipients.type !== "roles" && recipients.type !== "specific" && recipients.type !== "group") {
                return NextResponse.json({ error: "recipients.type must be 'roles', 'specific', or 'group'" }, { status: 400 })
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
            if (recipients.type === "group" && (!recipients.groupId || typeof recipients.groupId !== "string")) {
                return NextResponse.json({ error: "recipients.groupId is required for group targeting" }, { status: 400 })
            }

            // For a group audience, resolve + personalise the address-book contacts
            // up front so we can fail fast on an empty/oversized group and then
            // enqueue them as pre-rendered "specific" recipients (each carrying its
            // own rendered_message). Backwards-compatible: roles/specific untouched.
            let groupSpecificUsers:
                | Array<{ phone: string; name?: string; renderedMessage?: string }>
                | undefined
            let targetGroupLabel: string[] = recipients.roles || ["specific"]
            if (recipients.type === "group") {
                const mergeFields = body.mergeFields !== false // default on
                let resolved
                try {
                    resolved = await resolveRecipients({ type: "group", groupId: recipients.groupId }, supabase)
                } catch (e: any) {
                    return NextResponse.json({ error: `Failed to resolve group: ${e?.message || e}` }, { status: 400 })
                }
                if (resolved.contacts.length === 0) {
                    return NextResponse.json({ error: "The selected group has no sendable contacts (all invalid or opted out)" }, { status: 400 })
                }
                if (resolved.contacts.length > 5000) {
                    return NextResponse.json({ error: "cannot target more than 5000 contacts at once" }, { status: 400 })
                }
                groupSpecificUsers = resolved.contacts.map((c) => ({
                    phone: c.phone,
                    name: c.firstName,
                    renderedMessage: mergeFields
                        ? personalize(message, { firstName: c.firstName, lastName: c.lastName, phone: c.phone })
                        : undefined,
                }))
                targetGroupLabel = [`group:${recipients.groupId}`]
            }

            const { data: broadcastLog, error: logError } = await supabase
                .from("broadcast_logs")
                .insert({
                    admin_id: callerId,
                    channels: channels,
                    target_type: recipients.type,
                    target_group: targetGroupLabel,
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
            // A group audience is enqueued as pre-rendered "specific" recipients.
            const enqueued = await enqueueRecipients(supabase, broadcastId, {
                targetType: recipients.type === "group" ? "specific" : recipients.type,
                roles: recipients.roles,
                specificUsers: recipients.type === "group" ? groupSpecificUsers : recipients.users,
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
