import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(request: NextRequest) {
    try {
        console.log("[CRON] Checking for expired subscriptions...")

        // Call the database function
        const { error } = await supabase.rpc("check_expired_subscriptions")

        if (error) {
            console.error("[CRON] Error checking subscriptions:", error)

            // Fallback: Manual check if RPC fails (e.g. function not yet created)
            console.log("[CRON] Attempting manual fallback check...")

            // 1. Get expired active subscriptions
            const { data: expiredSubs } = await supabase
                .from("user_subscriptions")
                .select("user_id")
                .eq("status", "active")
                .lt("end_date", new Date().toISOString())

            if (expiredSubs && expiredSubs.length > 0) {
                const userIds = expiredSubs.map(s => s.user_id)

                // 2. Revert roles
                await supabase
                    .from("users")
                    .update({ role: "user", updated_at: new Date().toISOString() })
                    .in("id", userIds)
                    .eq("role", "dealer")

                // 3. Mark subscriptions as expired
                await supabase
                    .from("user_subscriptions")
                    .update({ status: "expired", updated_at: new Date().toISOString() })
                    .in("user_id", userIds)
                    .eq("status", "active")
                    .lt("end_date", new Date().toISOString())

                console.log(`[CRON] Successfully processed ${expiredSubs.length} expired subscriptions manually.`)
            } else {
                console.log("[CRON] No expired subscriptions found.")
            }
        } else {
            console.log("[CRON] ✓ Expired subscriptions checked via RPC.")
        }

        return NextResponse.json({ success: true, timestamp: new Date().toISOString() })
    } catch (error) {
        console.error("[CRON] Fatal error:", error)
        return NextResponse.json({ error: "Internal server error" }, { status: 500 })
    }
}
