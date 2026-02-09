/**
 * Fix Orphaned Blacklisted Orders
 * 
 * This script finds and fixes orders that have status="blacklisted" 
 * but the phone number is no longer in the blacklist table.
 * 
 * This can happen when:
 * 1. A number was removed from blacklist before the normalization fix was deployed
 * 2. Orders exist with phone format that doesn't match blacklist entry format
 */

import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * Get both formats of a phone number
 */
function getPhoneFormats(phoneNumber: string): string[] {
    const cleaned = phoneNumber.replace(/\D/g, "")
    const withoutZero = cleaned.startsWith("0") ? cleaned.substring(1) : cleaned
    const withZero = cleaned.startsWith("0") ? cleaned : "0" + cleaned
    return [withoutZero, withZero]
}

/**
 * Check if phone is currently blacklisted
 */
async function isPhoneBlacklisted(phone: string): Promise<boolean> {
    const formats = getPhoneFormats(phone)

    const { data, error } = await supabase
        .from("blacklisted_phone_numbers")
        .select("id")
        .in("phone_number", formats)
        .limit(1)

    if (error) {
        console.error("Error checking blacklist:", error)
        return false
    }

    return data && data.length > 0
}

async function fixOrphanedBlacklistedOrders() {
    console.log("🔍 Finding orphaned blacklisted orders...\n")

    // Get all orders with blacklisted status OR blacklisted queue
    const { data: shopOrders } = await supabase
        .from("shop_orders")
        .select("id, customer_phone, order_status, queue")
        .or("order_status.eq.blacklisted,queue.eq.blacklisted")

    const { data: walletOrders } = await supabase
        .from("orders")
        .select("id, phone_number, status, queue")
        .or("status.eq.blacklisted,queue.eq.blacklisted")

    console.log(`Found ${shopOrders?.length || 0} shop orders with blacklisted status/queue`)
    console.log(`Found ${walletOrders?.length || 0} wallet orders with blacklisted status/queue\n`)

    let shopOrdersFixed = 0
    let walletOrdersFixed = 0

    // Check shop orders
    if (shopOrders && shopOrders.length > 0) {
        console.log("Checking shop orders...")
        for (const order of shopOrders) {
            const isBlacklisted = await isPhoneBlacklisted(order.customer_phone)

            if (!isBlacklisted) {
                console.log(`  ✓ Order ${order.id} - Phone ${order.customer_phone} NOT in blacklist, fixing...`)

                const { error } = await supabase
                    .from("shop_orders")
                    .update({
                        order_status: "pending",
                        queue: "default",
                        updated_at: new Date().toISOString(),
                    })
                    .eq("id", order.id)

                if (error) {
                    console.error(`  ✗ Failed to fix order ${order.id}:`, error)
                } else {
                    shopOrdersFixed++
                }
            } else {
                console.log(`  - Order ${order.id} - Phone ${order.customer_phone} is STILL blacklisted, skipping`)
            }
        }
    }

    // Check wallet orders
    if (walletOrders && walletOrders.length > 0) {
        console.log("\nChecking wallet orders...")
        for (const order of walletOrders) {
            const isBlacklisted = await isPhoneBlacklisted(order.phone_number)

            if (!isBlacklisted) {
                console.log(`  ✓ Order ${order.id} - Phone ${order.phone_number} NOT in blacklist, fixing...`)

                const { error } = await supabase
                    .from("orders")
                    .update({
                        status: "pending",
                        queue: "default",
                        updated_at: new Date().toISOString(),
                    })
                    .eq("id", order.id)

                if (error) {
                    console.error(`  ✗ Failed to fix order ${order.id}:`, error)
                } else {
                    walletOrdersFixed++
                }
            } else {
                console.log(`  - Order ${order.id} - Phone ${order.phone_number} is STILL blacklisted, skipping`)
            }
        }
    }

    console.log(`\n✅ Done!`)
    console.log(`   Shop orders fixed: ${shopOrdersFixed}`)
    console.log(`   Wallet orders fixed: ${walletOrdersFixed}`)
    console.log(`   Total fixed: ${shopOrdersFixed + walletOrdersFixed}`)
}

// Run the script
fixOrphanedBlacklistedOrders()
    .then(() => {
        console.log("\n✨ Script completed successfully")
        process.exit(0)
    })
    .catch((error) => {
        console.error("\n❌ Script failed:", error)
        process.exit(1)
    })
