import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

/**
 * Admin API endpoint to sync all shop balances
 * 
 * This recalculates shop_available_balance for all shops to fix discrepancies
 * 
 * GET /api/admin/sync-shop-balances
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

async function syncShopBalance(supabaseClient: any, shopId: string) {
    try {
        // Just call the Postgres function directly via RPC
        const { error } = await supabaseClient.rpc("sync_shop_balance", {
            p_shop_id: shopId
        })

        if (error) {
            return { success: false, error: error.message }
        }

        return {
            success: true,
        }
    } catch (error: any) {
        return { success: false, error: error.message }
    }
}

export async function GET(req: NextRequest) {
    const { isAdmin, errorResponse } = await verifyAdminAccess(req)
    if (!isAdmin) return errorResponse

    try {
        const supabaseClient = createClient(supabaseUrl, serviceRoleKey)

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
