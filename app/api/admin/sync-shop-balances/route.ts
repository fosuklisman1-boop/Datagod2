import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

/**
 * Admin API endpoint to sync all shop balances
 * 
 * This recalculates shop_available_balance for all shops to fix discrepancies
 * 
 * GET /api/admin/sync-shop-balances
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Helper to fetch all profits with pagination
async function fetchAllProfits(supabase: any, shopId: string) {
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

        if (error) break

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

async function syncShopBalance(supabase: any, shopId: string) {
    try {
        // Get all profits with pagination
        const profits = await fetchAllProfits(supabase, shopId)

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
        const { data: approvedWithdrawals } = await supabase
            .from("withdrawal_requests")
            .select("amount")
            .eq("shop_id", shopId)
            .eq("status", "approved")

        let totalApprovedWithdrawals = 0
        if (approvedWithdrawals) {
            totalApprovedWithdrawals = approvedWithdrawals.reduce((sum: number, w: any) => sum + (w.amount || 0), 0)
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
            return { success: false, error: insertError.message }
        }

        return {
            success: true,
            breakdown: {
                total: breakdown.totalProfit,
                credited: breakdown.creditedProfit,
                pending: breakdown.pendingProfit,
                available: availableBalance
            }
        }
    } catch (error: any) {
        return { success: false, error: error.message }
    }
}

export async function GET(req: NextRequest) {
    try {
        // Verify admin access
        const authHeader = req.headers.get("Authorization")
        if (!authHeader?.startsWith("Bearer ")) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        const token = authHeader.slice(7)
        const supabaseClient = createClient(supabaseUrl, serviceRoleKey)
        const { data: { user }, error: userError } = await supabaseClient.auth.getUser(token)

        if (userError || !user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        // Check if user is admin
        const isAdmin = user.user_metadata?.role === "admin"
        if (!isAdmin) {
            const { data: userData } = await supabaseClient
                .from("users")
                .select("role")
                .eq("id", user.id)
                .single()

            if (userData?.role !== "admin") {
                return NextResponse.json({ error: "Admin access required" }, { status: 403 })
            }
        }

        // Get all shops
        const { data: shops, error: shopsError } = await supabaseClient
            .from("user_shops")
            .select("id, shop_name")

        if (shopsError) {
            return NextResponse.json({ error: shopsError.message }, { status: 500 })
        }

        if (!shops || shops.length === 0) {
            return NextResponse.json({ success: true, message: "No shops found", results: [] })
        }

        // Sync all shops
        const results = []
        for (const shop of shops) {
            const result = await syncShopBalance(supabaseClient, shop.id)
            results.push({
                shopId: shop.id,
                shopName: shop.shop_name,
                ...result
            })
        }

        const successCount = results.filter(r => r.success).length
        const failCount = results.filter(r => !r.success).length

        return NextResponse.json({
            success: true,
            message: `Synced ${successCount} shops successfully${failCount > 0 ? `, ${failCount} failed` : ""}`,
            totalShops: shops.length,
            successCount,
            failCount,
            results
        })
    } catch (error: any) {
        console.error("[SYNC-SHOP-BALANCES] Error:", error)
        return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 })
    }
}
