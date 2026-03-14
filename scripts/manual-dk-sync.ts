import { createClient } from "@supabase/supabase-js"
import * as dotenv from "dotenv"
import path from "path"
import { syncMTNOrderStatus } from "../lib/mtn-fulfillment"

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

async function manualSync() {
    console.log("--- Manual Datakazina Sync Started ---")

    // 1. Fetch all pending/processing Datakazina orders
    const { data: pendingOrders, error } = await supabase
        .from("mtn_fulfillment_tracking")
        .select("id, mtn_order_id, status")
        .eq("provider", "datakazina")
        .in("status", ["pending", "processing"])

    if (error) {
        console.error("Error fetching pending orders:", error)
        return
    }

    if (!pendingOrders || pendingOrders.length === 0) {
        console.log("No pending Datakazina orders found.")
        return
    }

    console.log(`Found ${pendingOrders.length} orders to sync.`)

    for (const order of pendingOrders) {
        console.log(`Syncing Tracking ID: ${order.id} (MTN ID: ${order.mtn_order_id})...`)
        try {
            const result = await syncMTNOrderStatus(order.id)
            if (result.success) {
                console.log(`✅ ${order.mtn_order_id}: ${result.newStatus || 'Unchanged'} - ${result.message}`)
            } else {
                console.warn(`⚠️ ${order.mtn_order_id}: Failed - ${result.message}`)
            }
        } catch (err) {
            console.error(`❌ Error syncing ${order.mtn_order_id}:`, err)
        }

        // Brief sleep to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 1000))
    }

    console.log("--- Manual Sync Completed ---")
}

manualSync().catch(console.error)
