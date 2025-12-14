import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

interface BulkOrderData {
  phone_number: string
  volume_gb: number
  network: string
  price: number
}

export async function POST(request: NextRequest) {
  try {
    const { orders, network } = await request.json()

    if (!orders || !Array.isArray(orders) || orders.length === 0) {
      return NextResponse.json(
        { error: "No valid orders provided" },
        { status: 400 }
      )
    }

    if (!network) {
      return NextResponse.json(
        { error: "Network is required" },
        { status: 400 }
      )
    }

    console.log(`[BULK-ORDERS] Creating ${orders.length} orders for network: ${network}`)

    // Get auth header to get user ID
    const authHeader = request.headers.get("authorization")
    if (!authHeader) {
      return NextResponse.json(
        { error: "Unauthorized - no auth token" },
        { status: 401 }
      )
    }

    const token = authHeader.replace("Bearer ", "")

    // Verify token and get user
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      console.error("[BULK-ORDERS] Auth error:", authError)
      return NextResponse.json(
        { error: "Unauthorized - invalid token" },
        { status: 401 }
      )
    }

    const userId = user.id
    console.log(`[BULK-ORDERS] User ID: ${userId}`)

    // Insert all orders
    const ordersToInsert = orders.map((order: BulkOrderData) => ({
      user_id: userId,
      phone_number: order.phone_number,
      size: order.volume_gb.toString(), // Convert to string as per schema
      network: network,
      price: order.price,
      status: "pending", // Use 'status' instead of 'order_status'
      created_at: new Date().toISOString(),
    }))

    const { data: createdOrders, error: insertError } = await supabase
      .from("orders")
      .insert(ordersToInsert)
      .select()

    if (insertError) {
      console.error("[BULK-ORDERS] Insert error:", insertError)
      return NextResponse.json(
        { error: `Failed to create orders: ${insertError.message}` },
        { status: 500 }
      )
    }

    console.log(`[BULK-ORDERS] Successfully created ${createdOrders?.length || 0} orders`)

    // Send notification for bulk order placement
    try {
      const { error: notifError } = await supabase
        .from("notifications")
        .insert([
          {
            user_id: userId,
            title: "Bulk Orders Placed",
            message: `Your bulk order of ${orders.length} order(s) for ${network} network has been placed successfully. Total cost: ₵${orders.reduce((sum: number, order: BulkOrderData) => sum + order.price, 0).toFixed(2)}`,
            type: "order_update",
            reference_id: `BULK-${Date.now()}`,
            action_url: `/dashboard/my-orders`,
            read: false,
          },
        ])
      if (notifError) {
        console.warn("[BULK-ORDERS] Failed to send notification:", notifError)
      } else {
        console.log("[BULK-ORDERS] ✓ Notification sent for bulk order placement")
      }
    } catch (notifError) {
      console.warn("[BULK-ORDERS] Error sending notification:", notifError)
    }

    // Calculate total cost
    const totalCost = orders.reduce((sum: number, order: BulkOrderData) => sum + order.price, 0)

    // Deduct from wallet - get current balance and totals first
    const { data: walletData, error: walletFetchError } = await supabase
      .from("wallets")
      .select("balance, total_spent")
      .eq("user_id", userId)
      .single()

    if (walletFetchError || !walletData) {
      console.error("[BULK-ORDERS] Failed to fetch wallet:", walletFetchError)
      return NextResponse.json(
        { error: "Failed to process wallet deduction" },
        { status: 500 }
      )
    }

    const currentBalance = walletData.balance || 0
    const currentTotalSpent = walletData.total_spent || 0
    const newBalance = Math.max(0, currentBalance - totalCost)
    const newTotalSpent = currentTotalSpent + totalCost

    const { error: updateError } = await supabase
      .from("wallets")
      .update({
        balance: newBalance,
        total_spent: newTotalSpent,
      })
      .eq("user_id", userId)

    if (updateError) {
      console.error("[BULK-ORDERS] Wallet update error:", updateError)
      // Don't fail the order creation if wallet update fails
      // Just log the error
    } else {
      console.log(`[BULK-ORDERS] Deducted ₵${totalCost} from wallet for user ${userId}`)

      // Create debit transaction record
      const { error: txError } = await supabase
        .from("transactions")
        .insert([{
          user_id: userId,
          type: "debit",
          amount: totalCost,
          reference_id: `BULK-${Date.now()}`,
          description: `Bulk order - ${orders.length} order(s) for ${network}`,
          source: "bulk_order",
          status: "completed",
          balance_before: currentBalance,
          balance_after: newBalance,
          created_at: new Date().toISOString(),
        }])

      if (txError) {
        console.error("[BULK-ORDERS] Transaction creation error:", txError)
        // Log but don't fail - transaction record is secondary
      } else {
        console.log(`[BULK-ORDERS] ✓ Transaction record created for ₵${totalCost}`)
      }
    }

    return NextResponse.json({
      success: true,
      count: createdOrders?.length || 0,
      orders: createdOrders,
      totalCost,
    })
  } catch (error) {
    console.error("[BULK-ORDERS] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
