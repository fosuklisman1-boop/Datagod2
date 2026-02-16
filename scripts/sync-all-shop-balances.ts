import { createClient } from "@supabase/supabase-js"
import { config } from "dotenv"

// Load environment variables from .env.local
config({ path: ".env.local" })

/**
 * One-time sync script to fix existing shop_available_balance discrepancies
 * 
 * This script re-syncs all shop balances to ensure the shop_available_balance
 * table matches the actual shop_profits records.
 * 
 * Run this after deploying the createProfitRecord fix to correct historical data.
 * 
 * Usage:
 *   npx tsx scripts/sync-all-shop-balances.ts
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!supabaseUrl || !serviceRoleKey) {
    console.error("❌ Missing required environment variables")
    console.error("   NEXT_PUBLIC_SUPABASE_URL:", !!supabaseUrl)
    console.error("   SUPABASE_SERVICE_ROLE_KEY:", !!serviceRoleKey)
    process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey)

// Helper to fetch all records with pagination
async function fetchAllProfits(shopId: string) {
    let allRecords: any[] = []
    let offset = 0
    const batchSize = 1000
    let hasMore = true

    while (hasMore) {
        const { data, error } = await supabase
            .from("shop_profits")
            .select("profit_amount, status")
            .eq("shop_id", shopId)
            .range(offset, offset + batchSize - 1)

        if (error) {
            console.error(`Error fetching profits for shop ${shopId}:`, error)
            break
        }

        if (data && data.length > 0) {
            allRecords = allRecords.concat(data)
            offset += batchSize
            hasMore = data.length === batchSize
        } else {
            hasMore = false
        }
    }

    return allRecords
}

async function syncShopBalance(shopId: string) {
    try {
        // Get all profits with pagination
        const profits = await fetchAllProfits(shopId)

        // Calculate totals by status
        const breakdown = {
            totalProfit: 0,
            creditedProfit: 0,
            withdrawnProfit: 0,
            pendingProfit: 0,
        }

        profits.forEach((p: any) => {
            const amount = p.profit_amount || 0
            breakdown.totalProfit += amount

            if (p.status === "credited") {
                breakdown.creditedProfit += amount
            } else if (p.status === "withdrawn") {
                breakdown.withdrawnProfit += amount
            } else if (p.status === "pending") {
                breakdown.pendingProfit += amount
            }
        })

        // Get approved withdrawals
        const { data: approvedWithdrawals, error: withdrawalError } = await supabase
            .from("withdrawal_requests")
            .select("amount")
            .eq("shop_id", shopId)
            .eq("status", "approved")

        let totalApprovedWithdrawals = 0
        if (!withdrawalError && approvedWithdrawals) {
            totalApprovedWithdrawals = approvedWithdrawals.reduce((sum, w) => sum + (w.amount || 0), 0)
        }

        // Available balance = credited profit - approved withdrawals
        const availableBalance = Math.max(0, breakdown.creditedProfit - totalApprovedWithdrawals)

        // Delete existing record and insert fresh
        await supabase
            .from("shop_available_balance")
            .delete()
            .eq("shop_id", shopId)

        const { error: insertError } = await supabase
            .from("shop_available_balance")
            .insert([
                {
                    shop_id: shopId,
                    available_balance: availableBalance,
                    total_profit: breakdown.totalProfit,
                    pending_profit: breakdown.pendingProfit,
                    credited_profit: breakdown.creditedProfit,
                    withdrawn_profit: breakdown.withdrawnProfit,
                    withdrawn_amount: breakdown.withdrawnProfit,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                }
            ])

        if (insertError) {
            console.error(`❌ Error syncing balance for shop ${shopId}:`, insertError)
            return false
        }

        console.log(`✓ Shop ${shopId}: Total=${breakdown.totalProfit.toFixed(2)}, Credited=${breakdown.creditedProfit.toFixed(2)}, Pending=${breakdown.pendingProfit.toFixed(2)}, Available=${availableBalance.toFixed(2)}`)
        return true
    } catch (error) {
        console.error(`❌ Error syncing shop ${shopId}:`, error)
        return false
    }
}

// Helper to fetch all shops with pagination
async function fetchAllShops() {
    let allRecords: any[] = []
    let offset = 0
    const batchSize = 1000
    let hasMore = true

    while (hasMore) {
        const { data, error } = await supabase
            .from("user_shops")
            .select("id, shop_name, user_id")
            .range(offset, offset + batchSize - 1)

        if (error) {
            console.error(`Error fetching shops:`, error)
            break
        }

        if (data && data.length > 0) {
            allRecords = allRecords.concat(data)
            offset += batchSize
            hasMore = data.length === batchSize
        } else {
            hasMore = false
        }
    }

    return allRecords
}

async function main() {
    console.log("🔄 Starting shop balance sync...")
    console.log("")

    // Get all shops with pagination
    const shops = await fetchAllShops()

    if (!shops || shops.length === 0) {
        console.log("ℹ️  No shops found")
        process.exit(0)
    }

    console.log(`Found ${shops.length} shops to sync`)
    console.log("")

    let successCount = 0
    let failCount = 0

    for (const shop of shops) {
        const success = await syncShopBalance(shop.id)
        if (success) {
            successCount++
        } else {
            failCount++
        }
    }

    console.log("")
    console.log("=".repeat(60))
    console.log(`✅ Successfully synced: ${successCount} shops`)
    if (failCount > 0) {
        console.log(`❌ Failed to sync: ${failCount} shops`)
    }
    console.log("=".repeat(60))
}

main().catch(console.error)
