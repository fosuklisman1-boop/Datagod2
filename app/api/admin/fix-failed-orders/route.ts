import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * GET: Preview failed orders that need fixing
 * POST: Actually fix the orders (update status and create missing profits)
 */

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url)
        const dryRun = searchParams.get("dryRun") !== "false" // Default to true

        console.log(`[FIX-FAILED-ORDERS] Starting ${dryRun ? "preview" : "fix"} mode...`)

        // Find shop orders that:
        // 1. Have order_status = "failed" or payment_status = "failed"
        // 2. But have a completed payment in wallet_payments
        const { data: failedOrders, error: ordersError } = await supabase
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
            .or("order_status.eq.failed,payment_status.eq.failed")
            .order("created_at", { ascending: false })
            .limit(500)

        if (ordersError) {
            console.error("[FIX-FAILED-ORDERS] Error fetching failed orders:", ordersError)
            return NextResponse.json({ error: ordersError.message }, { status: 500 })
        }

        console.log(`[FIX-FAILED-ORDERS] Found ${failedOrders?.length || 0} failed orders to check`)

        const ordersToFix: any[] = []
        const ordersWithoutPayment: any[] = []

        // Check each failed order to see if it has a completed payment
        for (const order of failedOrders || []) {
            // Look up the payment by transaction_id or reference_code
            const { data: payment, error: paymentError } = await supabase
                .from("wallet_payments")
                .select("id, reference, status, amount, order_id")
                .eq("order_id", order.id)
                .maybeSingle()

            if (paymentError) {
                console.warn(`[FIX-FAILED-ORDERS] Error checking payment for order ${order.id}:`, paymentError)
                continue
            }

            if (payment && payment.status === "completed") {
                // This order was paid but marked as failed - needs fixing!
                ordersToFix.push({
                    ...order,
                    payment_id: payment.id,
                    payment_reference: payment.reference,
                    payment_amount: payment.amount,
                })
            } else if (!payment) {
                // Check by reference
                const { data: paymentByRef } = await supabase
                    .from("wallet_payments")
                    .select("id, reference, status, amount, order_id")
                    .eq("reference", order.transaction_id || order.reference_code)
                    .maybeSingle()

                if (paymentByRef && paymentByRef.status === "completed") {
                    ordersToFix.push({
                        ...order,
                        payment_id: paymentByRef.id,
                        payment_reference: paymentByRef.reference,
                        payment_amount: paymentByRef.amount,
                    })
                } else {
                    ordersWithoutPayment.push(order)
                }
            } else {
                ordersWithoutPayment.push(order)
            }
        }

        console.log(`[FIX-FAILED-ORDERS] ${ordersToFix.length} orders need fixing (have completed payments)`)
        console.log(`[FIX-FAILED-ORDERS] ${ordersWithoutPayment.length} orders have no completed payment (legitimate failures)`)

        // Calculate total missing profits
        const totalMissingProfits = ordersToFix.reduce((sum, o) => sum + (o.profit_amount || 0), 0)

        return NextResponse.json({
            success: true,
            summary: {
                totalFailedOrders: failedOrders?.length || 0,
                ordersNeedingFix: ordersToFix.length,
                legitimateFailures: ordersWithoutPayment.length,
                totalMissingProfits: totalMissingProfits.toFixed(2),
            },
            ordersToFix: ordersToFix.map(o => ({
                id: o.id,
                phone: o.customer_phone,
                network: o.network,
                volume_gb: o.volume_gb,
                total_price: o.total_price,
                profit_amount: o.profit_amount,
                order_status: o.order_status,
                payment_status: o.payment_status,
                payment_reference: o.payment_reference,
                created_at: o.created_at,
            })),
            message: dryRun
                ? "Preview mode - no changes made. Call POST to fix these orders."
                : "Orders identified. Use POST with orderId to fix individual orders.",
        })
    } catch (error) {
        console.error("[FIX-FAILED-ORDERS] Error:", error)
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Failed to check orders" },
            { status: 500 }
        )
    }
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json()
        const { orderId, fixAll } = body

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
            ordersToFix = [order]
        } else if (fixAll) {
            // Get all failed orders with completed payments
            const { data: failedOrders } = await supabase
                .from("shop_orders")
                .select("*")
                .or("order_status.eq.failed,payment_status.eq.failed")
                .limit(500)

            for (const order of failedOrders || []) {
                const { data: payment } = await supabase
                    .from("wallet_payments")
                    .select("*")
                    .eq("order_id", order.id)
                    .eq("status", "completed")
                    .maybeSingle()

                if (payment) {
                    ordersToFix.push({ ...order, payment })
                }
            }
        }

        // Fix each order
        for (const order of ordersToFix) {
            try {
                console.log(`[FIX-FAILED-ORDERS] Fixing order ${order.id}...`)

                // 1. Update order status to pending (so it can be fulfilled)
                const { error: updateError } = await supabase
                    .from("shop_orders")
                    .update({
                        order_status: "pending",
                        payment_status: "completed",
                        updated_at: new Date().toISOString(),
                    })
                    .eq("id", order.id)

                if (updateError) {
                    results.push({ orderId: order.id, success: false, error: updateError.message })
                    continue
                }

                // 2. Check if profit record already exists
                const { data: existingProfit } = await supabase
                    .from("shop_profits")
                    .select("id")
                    .eq("shop_order_id", order.id)
                    .maybeSingle()

                if (!existingProfit && order.profit_amount > 0) {
                    // 3. Create missing profit record
                    // Get current balance
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
                        console.error(`[FIX-FAILED-ORDERS] Error creating profit for ${order.id}:`, profitError)
                        results.push({ orderId: order.id, success: false, error: `Status fixed but profit failed: ${profitError.message}` })
                        continue
                    }

                    console.log(`[FIX-FAILED-ORDERS] ✓ Created missing profit: GHS ${order.profit_amount}`)
                }

                results.push({
                    orderId: order.id,
                    success: true,
                    profitAmount: order.profit_amount,
                    message: existingProfit ? "Status fixed (profit already existed)" : "Status fixed and profit created",
                })
            } catch (err) {
                results.push({ orderId: order.id, success: false, error: String(err) })
            }
        }

        const successCount = results.filter(r => r.success).length
        const totalProfitsRestored = results
            .filter(r => r.success && r.profitAmount)
            .reduce((sum, r) => sum + (r.profitAmount || 0), 0)

        return NextResponse.json({
            success: true,
            summary: {
                totalProcessed: results.length,
                successCount,
                failedCount: results.length - successCount,
                totalProfitsRestored: totalProfitsRestored.toFixed(2),
            },
            results,
        })
    } catch (error) {
        console.error("[FIX-FAILED-ORDERS] Error:", error)
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Failed to fix orders" },
            { status: 500 }
        )
    }
}
