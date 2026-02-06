import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Validate environment variables
if (!supabaseUrl || !serviceRoleKey) {
    console.error('[ORDER-HISTORY] CRITICAL: Missing environment variables!')
    console.error('[ORDER-HISTORY] NEXT_PUBLIC_SUPABASE_URL:', supabaseUrl ? 'Set' : 'NOT SET')
    console.error('[ORDER-HISTORY] SUPABASE_SERVICE_ROLE_KEY:', serviceRoleKey ? 'Set' : 'NOT SET')
}

const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(request: NextRequest) {
    try {
        console.log('[ORDER-HISTORY] API called')
        console.log('[ORDER-HISTORY] Supabase URL:', supabaseUrl ? 'Set' : 'NOT SET')
        console.log('[ORDER-HISTORY] Service key:', serviceRoleKey ? `Set (${serviceRoleKey.length} chars)` : 'NOT SET')

        const { isAdmin, errorResponse } = await verifyAdminAccess(request)
        console.log('[ORDER-HISTORY] Admin check result:', isAdmin)

        if (!isAdmin) {
            console.log('[ORDER-HISTORY] Access denied - not admin')
            return errorResponse
        }

        const { searchParams } = new URL(request.url)
        const dateFrom = searchParams.get("dateFrom")
        const dateTo = searchParams.get("dateTo")
        const network = searchParams.get("network") // "all" or specific network
        const limit = parseInt(searchParams.get("limit") || "100")
        const offset = parseInt(searchParams.get("offset") || "0")

        console.log(`[ORDER-HISTORY] Fetching history. Date: ${dateFrom} to ${dateTo}, Network: ${network}`)

        // Base query for Bulk/Wallet Orders (wallet deduction = payment, show all regardless of fulfillment)
        let bulkQuery = supabase
            .from("orders")
            .select("id, created_at, phone_number, price, size, network, status")
        // No status filter - wallet was already debited, so all orders represent completed payments

        // Base query for Shop Orders
        let shopQuery = supabase
            .from("shop_orders")
            .select("id, created_at, customer_phone, total_price, volume_gb, network, order_status, payment_status")
            .eq("payment_status", "completed")

        // Apply Date Filters
        if (dateFrom) {
            bulkQuery = bulkQuery.gte("created_at", dateFrom)
            shopQuery = shopQuery.gte("created_at", dateFrom)
        }
        if (dateTo) {
            // Add one day to dateTo to include the end date fully if it's just a date string (YYYY-MM-DD)
            // If it includes time, rely on client. Assuming ISO strings or YYYY-MM-DD.
            // If checking "for the day", client normally sends Start of Day and End of Day.
            // We'll trust the input is properly formatted ISO or comparable.
            bulkQuery = bulkQuery.lte("created_at", dateTo)
            shopQuery = shopQuery.lte("created_at", dateTo)
        }

        // Apply Network Filters
        if (network && network !== "all") {
            // Normalize 'MTN' etc if needed, but assuming exact match for now
            bulkQuery = bulkQuery.ilike("network", `%${network}%`)
            shopQuery = shopQuery.ilike("network", `%${network}%`)
        }

        // Execute Queries in Parallel
        console.log('[ORDER-HISTORY] Executing queries...')
        console.log('[ORDER-HISTORY] Date range:', dateFrom, 'to', dateTo)
        console.log('[ORDER-HISTORY] Network filter:', network)

        const [bulkRes, shopRes] = await Promise.all([
            bulkQuery.order("created_at", { ascending: false }).limit(5000),
            shopQuery.order("created_at", { ascending: false }).limit(5000)
        ])

        console.log('[ORDER-HISTORY] Bulk query result:', bulkRes.error ? 'ERROR' : `${bulkRes.data?.length || 0} rows`)
        console.log('[ORDER-HISTORY] Shop query result:', shopRes.error ? 'ERROR' : `${shopRes.data?.length || 0} rows`)

        if (bulkRes.error) {
            console.error('[ORDER-HISTORY] Bulk orders query error:', bulkRes.error)
            throw new Error(`Bulk orders query failed: ${bulkRes.error.message}`)
        }
        if (shopRes.error) {
            console.error('[ORDER-HISTORY] Shop orders query error:', shopRes.error)
            throw new Error(`Shop orders query failed: ${shopRes.error.message}`)
        }

        const bulkOrders = bulkRes.data || []
        const shopOrders = shopRes.data || []

        // Combine and Normalize
        const allOrders = [
            ...bulkOrders.map((o: any) => ({
                id: o.id,
                type: "bulk",
                created_at: o.created_at,
                phone: o.phone_number,
                network: o.network,
                size: o.size, // volume in GB
                price: o.price,
                status: o.status // fulfillment status
            })),
            ...shopOrders.map((o: any) => ({
                id: o.id,
                type: "shop",
                created_at: o.created_at,
                phone: o.customer_phone,
                network: o.network,
                size: o.volume_gb,
                price: o.total_price,
                status: o.order_status
            }))
        ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

        // Calculate Stats
        const totalOrders = allOrders.length
        const totalVolume = allOrders.reduce((acc, curr) => acc + (Number(curr.size) || 0), 0)
        const totalRevenue = allOrders.reduce((acc, curr) => acc + (Number(curr.price) || 0), 0)

        // Pagination for the list response
        const paginatedOrders = allOrders.slice(offset, offset + limit)

        return NextResponse.json({
            success: true,
            stats: {
                totalOrders,
                totalVolume: Math.round(totalVolume * 100) / 100,
                totalRevenue: Math.round(totalRevenue * 100) / 100
            },
            orders: paginatedOrders,
            pagination: {
                total: totalOrders,
                limit,
                offset,
                hasMore: offset + limit < totalOrders
            }
        })

    } catch (error) {
        console.error("[ORDER-HISTORY] Error:", error)
        console.error("[ORDER-HISTORY] Error stack:", error instanceof Error ? error.stack : 'No stack')
        console.error("[ORDER-HISTORY] Error message:", error instanceof Error ? error.message : String(error))

        return NextResponse.json(
            {
                error: "Failed to fetch order history",
                details: error instanceof Error ? error.message : String(error),
                stack: process.env.NODE_ENV === 'development' ? (error instanceof Error ? error.stack : undefined) : undefined,
                params: {
                    dateFrom: request.nextUrl.searchParams.get("dateFrom"),
                    dateTo: request.nextUrl.searchParams.get("dateTo"),
                    network: request.nextUrl.searchParams.get("network")
                }
            },
            { status: 500 }
        )
    }
}
