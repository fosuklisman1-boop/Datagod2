import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { notificationService, notificationTemplates } from "@/lib/notification-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function POST(request: NextRequest) {
  try {
    const { packageId, network, size, price, phoneNumber } = await request.json()

    // Validate required fields
    if (!phoneNumber) {
      return NextResponse.json({ error: "Phone number is required" }, { status: 400 })
    }

    // Get auth token from header
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const token = authHeader.substring(7)

    // Verify user and get user ID
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)
    const {
      data: { user },
      error: authError,
    } = await supabaseAdmin.auth.getUser(token)

    if (authError || !user) {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 })
    }

    const userId = user.id

    // Get user's wallet
    const { data: walletData, error: walletError } = await supabaseAdmin
      .from("wallets")
      .select("balance, total_spent")
      .eq("user_id", userId)
      .single()

    if (walletError) {
      return NextResponse.json(
        { error: "Wallet not found", details: walletError.message },
        { status: 404 }
      )
    }

    const wallet = walletData as { balance: number; total_spent: number }

    // Check if wallet has enough balance
    if (wallet.balance < price) {
      return NextResponse.json(
        {
          error: "Insufficient balance",
          required: price,
          available: wallet.balance,
        },
        { status: 402 }
      )
    }

    // Create order
    const { data: order, error: orderError } = await supabaseAdmin
      .from("orders")
      .insert([
        {
          user_id: userId,
          package_id: packageId,
          network,
          size,
          price,
          phone_number: phoneNumber,
          status: "pending",
          order_code: `ORD-${Date.now()}`,
          created_at: new Date().toISOString(),
        },
      ])
      .select()

    if (orderError) {
      return NextResponse.json(
        { error: "Failed to create order", details: orderError.message },
        { status: 500 }
      )
    }

    // Deduct from wallet
    const newBalance = wallet.balance - price

    const { error: updateWalletError } = await supabaseAdmin
      .from("wallets")
      .update({
        balance: newBalance,
        total_spent: (wallet.total_spent || 0) + price,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)

    if (updateWalletError) {
      return NextResponse.json(
        { error: "Failed to update wallet", details: updateWalletError.message },
        { status: 500 }
      )
    }

    // Create transaction record
    const { error: transactionError } = await supabaseAdmin
      .from("transactions")
      .insert([
        {
          user_id: userId,
          type: "debit",
          source: "data_purchase",
          amount: price,
          balance_before: wallet.balance,
          balance_after: newBalance,
          description: `Data purchase: ${network} ${size}`,
          reference_id: order[0].id,
          status: "completed",
          created_at: new Date().toISOString(),
        },
      ])

    if (transactionError) {
      console.error("Failed to create transaction record:", transactionError)
    }

    // Send notification about successful purchase
    try {
      const notificationData = notificationTemplates.paymentSuccess(price, order[0].id)
      await notificationService.createNotification(
        userId,
        notificationData.title,
        `${notificationData.message} Order: ${network} - ${size}GB. Order Code: ${order[0].order_code}`,
        notificationData.type,
        {
          reference_id: notificationData.reference_id,
          action_url: `/dashboard/my-orders?orderId=${order[0].id}`,
        }
      )
      console.log(`[NOTIFICATION] Purchase success notification sent to user ${userId}`)
    } catch (notifError) {
      console.warn("[NOTIFICATION] Failed to send purchase notification:", notifError)
      // Don't fail the purchase if notification fails
    }

    return NextResponse.json({
      success: true,
      message: "Purchase successful",
      order: order[0],
      newBalance,
    })
  } catch (error) {
    console.error("Purchase error:", error)
    return NextResponse.json(
      { error: "Purchase failed", details: String(error) },
      { status: 500 }
    )
  }
}
