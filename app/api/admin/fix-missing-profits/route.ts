import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * Find completed shop orders that are missing profit records
 * These are orders that were manually marked as completed but never had profits credited
 * 
 * GET: Preview orders missing profits
 * POST: Create missing profit records
 */

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url)
        const dateFrom = searchParams.get("dateFrom") // e.g., "2026-01-29T19:00:00"
        const dateTo = searchParams.get("dateTo") // e.g., "2026-01-29T20:00:00"

        console.log(`[FIX-MISSING-PROFITS] Searching for orders missing profits...`)

        // Build query for completed shop orders
        let query = supabase
            .from("shop_orders")
            .select(`
        id,
        shop_id,
        customer_phone,
        network,
        volume_gb,
        base_price,
        profit_amount,
        total_price,
        order_status,
        payment_status,
        reference_code,
        transaction_id,
        created_at
      `)
            .in("order_status", ["completed", "processing", "pending"])
            .eq("payment_status", "completed")
            .gt("profit_amount", 0)
            .order("created_at", { ascending: false })
            .limit(500)

        // Apply date filters if provided
        if (dateFrom) {
            query = query.gte("created_at", dateFrom)
        }
        if (dateTo) {
            query = query.lte("created_at", dateTo)
        }

        const { data: completedOrders, error: ordersError } = await query

        if (ordersError) {
            console.error("[FIX-MISSING-PROFITS] Error fetching orders:", ordersError)
            return NextResponse.json({ error: ordersError.message }, { status: 500 })
        }

        console.log(`[FIX-MISSING-PROFITS] Found ${completedOrders?.length || 0} completed orders to check`)

        // Find orders missing profit records
        const ordersMissingProfits: any[] = []
        const ordersWithProfits: any[] = []

        for (const order of completedOrders || []) {
            // Check if profit record exists for this order
            const { data: profitRecord } = await supabase
                .from("shop_profits")
                .select("id, profit_amount, status")
                .eq("shop_order_id", order.id)
                .maybeSingle()

            if (!profitRecord) {
                // Missing profit record!
                ordersMissingProfits.push(order)
            } else {
                ordersWithProfits.push({
                    ...order,
                    profit_status: profitRecord.status,
                })
            }
        }

        console.log(`[FIX-MISSING-PROFITS] ${ordersMissingProfits.length} orders are MISSING profit records`)
        console.log(`[FIX-MISSING-PROFITS] ${ordersWithProfits.length} orders have profit records`)

        // Calculate total missing profits
        const totalMissingProfits = ordersMissingProfits.reduce((sum, o) => sum + (o.profit_amount || 0), 0)

        return NextResponse.json({
            success: true,
            summary: {
                totalChecked: completedOrders?.length || 0,
                ordersMissingProfits: ordersMissingProfits.length,
                ordersWithProfits: ordersWithProfits.length,
                totalMissingProfits: totalMissingProfits.toFixed(2),
            },
            ordersMissingProfits: ordersMissingProfits.map(o => ({
                id: o.id,
                shop_id: o.shop_id,
                phone: o.customer_phone,
                network: o.network,
                volume_gb: o.volume_gb,
                total_price: o.total_price,
                profit_amount: o.profit_amount,
                order_status: o.order_status,
                created_at: o.created_at,
            })),
            message: "Use POST with { fixAll: true } or { orderId: 'uuid' } to create missing profits",
        })
    } catch (error) {
        console.error("[FIX-MISSING-PROFITS] Error:", error)
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Failed to check orders" },
            { status: 500 }
        )
    }
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json()
        const { orderId, fixAll, dateFrom, dateTo } = body

        if (!orderId && !fixAll) {
            return NextResponse.json(
                { error: "Provide orderId or set fixAll: true" },
                { status: 400 }
            )
        }

        const results: any[] = []

        // Get orders to fix
        let ordersToFix: any[] = []

        if (orderId) {
            // Fix single order
            const { data: order, error } = await supabase
                .from("shop_orders")
                .select("*")
                .eq("id", orderId)
                .single()

            if (error || !order) {
                return NextResponse.json({ error: "Order not found" }, { status: 404 })
            }

            // Check if profit exists
            const { data: existingProfit } = await supabase
                .from("shop_profits")
                .select("id")
                .eq("shop_order_id", orderId)
                .maybeSingle()

            if (existingProfit) {
                return NextResponse.json({
                    success: true,
                    message: "Profit record already exists for this order"
                })
            }

            ordersToFix = [order]
        } else if (fixAll) {
            // Build query for completed orders
            let query = supabase
                .from("shop_orders")
                .select("*")
                .in("order_status", ["completed", "processing", "pending"])
                .eq("payment_status", "completed")
                .gt("profit_amount", 0)
                .limit(500)

            if (dateFrom) {
                query = query.gte("created_at", dateFrom)
            }
            if (dateTo) {
                query = query.lte("created_at", dateTo)
            }

            const { data: completedOrders } = await query

            // Filter to only those missing profit records
            for (const order of completedOrders || []) {
                const { data: existingProfit } = await supabase
                    .from("shop_profits")
                    .select("id")
                    .eq("shop_order_id", order.id)
                    .maybeSingle()

                if (!existingProfit) {
                    ordersToFix.push(order)
                }
            }
        }

        console.log(`[FIX-MISSING-PROFITS] Creating profits for ${ordersToFix.length} orders...`)

        // Create profit records
        for (const order of ordersToFix) {
            try {
                // Double-check if profit exists (prevents race conditions)
                const { data: alreadyExists } = await supabase
                    .from("shop_profits")
                    .select("id")
                    .eq("shop_order_id", order.id)
                    .maybeSingle()

                if (alreadyExists) {
                    results.push({
                        orderId: order.id,
                        success: true,
                        message: "Profit already exists (skipped)",
                    })
                    continue
                }

                // Get current balance for the shop
                const { data: allProfits } = await supabase
                    .from("shop_profits")
                    .select("profit_amount, status")
                    .eq("shop_id", order.shop_id)

                const balanceBefore = (allProfits || []).reduce((sum: number, p: any) => {
                    if (p.status === "pending" || p.status === "credited") {
                        return sum + (p.profit_amount || 0)
                    }
                    return sum
                }, 0)

                const balanceAfter = balanceBefore + order.profit_amount

                const { error: profitError } = await supabase
                    .from("shop_profits")
                    .insert({
                        shop_id: order.shop_id,
                        shop_order_id: order.id,
                        profit_amount: order.profit_amount,
                        profit_balance_before: balanceBefore,
                        profit_balance_after: balanceAfter,
                        status: "credited",
                        created_at: new Date().toISOString(),
                    })

                if (profitError) {
                    // Check if it's a duplicate key error
                    if (profitError.code === "23505") {
                        results.push({
                            orderId: order.id,
                            success: true,
                            message: "Profit already exists (constraint)",
                        })
                    } else {
                        console.error(`[FIX-MISSING-PROFITS] Error creating profit for ${order.id}:`, profitError)
                        results.push({
                            orderId: order.id,
                            success: false,
                            error: profitError.message
                        })
                    }
                } else {
                    console.log(`[FIX-MISSING-PROFITS] ✓ Created profit for order ${order.id}: GHS ${order.profit_amount}`)
                    results.push({
                        orderId: order.id,
                        shopId: order.shop_id,
                        success: true,
                        profitAmount: order.profit_amount,
                        message: "Profit record created",
                    })
                }
            } catch (err) {
                results.push({ orderId: order.id, success: false, error: String(err) })
            }
        }

        const successCount = results.filter(r => r.success).length
        const totalProfitsCreated = results
            .filter(r => r.success && r.profitAmount)
            .reduce((sum, r) => sum + (r.profitAmount || 0), 0)

        return NextResponse.json({
            success: true,
            summary: {
                totalProcessed: results.length,
                successCount,
                failedCount: results.length - successCount,
                totalProfitsCreated: totalProfitsCreated.toFixed(2),
            },
            results,
        })
    } catch (error) {
        console.error("[FIX-MISSING-PROFITS] Error:", error)
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Failed to create profits" },
            { status: 500 }
        )
    }
}
