import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { drainBroadcasts, MAX_ATTEMPTS } from "@/lib/broadcast-drain"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Retry is now a single, terminating operation: reset the failed recipients
// back into the queue and run one drain. There is no client-side while(hasMore)
// loop anymore — the old logic re-counted permanently-failing rows every round
// and spun forever. Each recipient carries an attempt counter, so even repeated
// retries can't loop indefinitely; only channels that previously failed are
// re-sent, so retrying never double-delivers.
export async function POST(req: NextRequest) {
    const { isAdmin, errorResponse } = await verifyAdminAccess(req)
    if (!isAdmin) return errorResponse

    try {
        const supabase = createClient(supabaseUrl, serviceRoleKey)
        const { broadcastId } = await req.json()

        if (!broadcastId) {
            return NextResponse.json({ error: "Missing broadcastId" }, { status: 400 })
        }

        const { data: broadcastLog, error: logError } = await supabase
            .from("broadcast_logs")
            .select("id")
            .eq("id", broadcastId)
            .single()

        if (logError || !broadcastLog) {
            return NextResponse.json({ error: "Broadcast not found" }, { status: 404 })
        }

        // Reset failed recipients so they're eligible again (fresh attempt budget).
        // Channels that already succeeded stay recorded in channel_status and are
        // skipped on the next drain, so this only re-sends the failures.
        const { data: reset, error: resetError } = await supabase
            .from("broadcast_recipients")
            .update({ status: "pending", attempts: 0, last_error: null, claimed_at: null })
            .eq("broadcast_id", broadcastId)
            .eq("status", "failed")
            .select("id")

        if (resetError) throw resetError

        const resetCount = reset?.length || 0

        if (resetCount === 0) {
            // Either nothing failed, or this broadcast predates the queue system
            // (no recipient rows were ever persisted for it).
            return NextResponse.json({
                success: true,
                retriedCount: 0,
                message: "No failed recipients to retry for this broadcast.",
            })
        }

        // Re-open the broadcast and send the first chunk now; the cron drains the rest.
        await supabase.from("broadcast_logs").update({ status: "processing" }).eq("id", broadcastId)
        await drainBroadcasts(supabase, { broadcastId, maxRecipients: 30 })

        // Return the freshly recomputed stats so the UI can refresh in one shot.
        const { data: updated } = await supabase
            .from("broadcast_logs")
            .select("results, status")
            .eq("id", broadcastId)
            .single()

        return NextResponse.json({
            success: true,
            retriedCount: resetCount,
            maxAttempts: MAX_ATTEMPTS,
            results: updated?.results,
            status: updated?.status,
        })
    } catch (error: any) {
        console.error("[RETRY] API Error:", error)
        return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 })
    }
}
