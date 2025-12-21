import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { notificationTemplates } from "@/lib/notification-service"
import { sendSMS } from "@/lib/sms-service"
import { customerTrackingService } from "@/lib/customer-tracking-service"
import { atishareService } from "@/lib/at-ishare-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey)

/**
 * Check if auto-fulfillment is enabled in admin settings
 */
async function isAutoFulfillmentEnabled(): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from("admin_settings")
      .select("value")
      .eq("key", "auto_fulfillment_enabled")
      .single()
    
    if (error || !data) {
      // Default to enabled if setting doesn't exist
      return true
    }
    
    return data.value?.enabled ?? true
  } catch (error) {
    console.warn("[PURCHASE] Error checking auto-fulfillment setting:", error)
    // Default to enabled on error
    return true
  }
}

export async function POST(request: NextRequest) {
  try {
    const { packageId, network, size, price, phoneNumber } = await request.json()

    console.log("[PURCHASE] ========== NEW ORDER REQUEST ==========")
    console.log("[PURCHASE] Package ID:", packageId)
    console.log("[PURCHASE] Network:", network)
    console.log("[PURCHASE] Size:", size)
    console.log("[PURCHASE] Price:", price)
    console.log("[PURCHASE] Phone:", phoneNumber)

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

    // Track customer if user has a shop (data packages page orders)
    try {
      const { data: shop } = await supabaseAdmin
        .from("user_shops")
        .select("id")
        .eq("user_id", userId)
        .single()

      if (shop?.id) {
        await customerTrackingService.trackDataPackageCustomer({
          shopId: shop.id,
          phoneNumber,
          orderId: order[0].id,
          amount: price,
          network,
          sizeGb: parseInt(size.toString().replace(/[^0-9]/g, "")) || 0,
        })
      }
    } catch (trackingError) {
      console.error("[DATA-PACKAGE-TRACKING] Error tracking customer:", trackingError)
      // Non-blocking: continue with the purchase even if tracking fails
    }

    console.log(`[PURCHASE] ========== FULFILLMENT CHECK ==========`)
    console.log(`[PURCHASE] About to check network for fulfillment`)

    // Trigger fulfillment for AT-iShare and Telecel orders (auto-fulfilled via Code Craft API)
    // Only if auto-fulfillment is enabled in admin settings
    const fulfillableNetworks = ["AT - iShare", "AT-iShare", "AT - ishare", "at - ishare", "Telecel", "telecel", "TELECEL"]
    const normalizedNetwork = network?.trim() || ""
    const isAutoFulfillable = fulfillableNetworks.some(n => n.toLowerCase() === normalizedNetwork.toLowerCase())
    
    // Check if auto-fulfillment is enabled
    const autoFulfillEnabled = await isAutoFulfillmentEnabled()
    const shouldFulfill = isAutoFulfillable && autoFulfillEnabled
    
    console.log(`[FULFILLMENT] Network received: "${network}" | Auto-fulfillable: ${isAutoFulfillable} | Auto-fulfill enabled: ${autoFulfillEnabled} | Should fulfill: ${shouldFulfill} | Order: ${order[0].id}`)
    
    if (shouldFulfill) {
      try {
        console.log(`[FULFILLMENT] Starting fulfillment trigger for ${network} order ${order[0].id} to ${phoneNumber}`)
        const sizeGb = parseInt(size.toString().replace(/[^0-9]/g, "")) || 0
        console.log(`[FULFILLMENT] Order details - Network: ${network}, Size: ${sizeGb}GB, Phone: ${phoneNumber}, OrderID: ${order[0].id}`)
        
        // Determine API network based on order network
        const networkLower = normalizedNetwork.toLowerCase()
        const apiNetwork = networkLower.includes("telecel") ? "TELECEL" : "AT"
        
        // Non-blocking fulfillment trigger
        console.log(`[FULFILLMENT] Calling atishareService.fulfillOrder with network: ${apiNetwork}`)
        atishareService.fulfillOrder({
          phoneNumber,
          sizeGb,
          orderId: order[0].id,
          network: apiNetwork,
          orderType: "wallet",  // Wallet orders use orders table
        }).then(result => {
          console.log(`[FULFILLMENT] Fulfillment response for order ${order[0].id}:`, result)
        }).catch(err => {
          console.error(`[FULFILLMENT] Error triggering fulfillment for order ${order[0].id}:`, err)
          // Non-blocking: don't fail purchase if fulfillment fails
        })
      } catch (fulfillmentError) {
        console.error("[FULFILLMENT] Error in fulfillment trigger block:", fulfillmentError)
        // Non-blocking: continue with purchase even if fulfillment fails
      }
    } else if (isAutoFulfillable && !autoFulfillEnabled) {
      console.log(`[FULFILLMENT] Auto-fulfillment disabled. Order ${order[0].id} will go to admin queue.`)
    } else {
      console.log(`[FULFILLMENT] Skipping fulfillment for network: ${normalizedNetwork} (not in fulfillable list)`)
    }

    // Send notification about successful purchase
    try {
      const notificationData = notificationTemplates.paymentSuccess(price, order[0].id)
      const { error: notifError } = await supabaseAdmin
        .from("notifications")
        .insert([
          {
            user_id: userId,
            title: notificationData.title,
            message: `${notificationData.message} Order: ${network} - ${size}GB. Order Code: ${order[0].order_code}`,
            type: notificationData.type,
            reference_id: notificationData.reference_id,
            action_url: `/dashboard/my-orders?orderId=${order[0].id}`,
            read: false,
          },
        ])
      if (notifError) {
        console.warn("[NOTIFICATION] Failed to send purchase notification:", notifError)
      } else {
        console.log(`[NOTIFICATION] Purchase success notification sent to user ${userId}`)
      }
    } catch (notifError) {
      console.warn("[NOTIFICATION] Failed to send purchase notification:", notifError)
      // Don't fail the purchase if notification fails
    }

    // Send SMS about successful purchase
    try {
      const smsMessage = `You have successfully placed an order of ${network} ${size}GB to ${phoneNumber}. If delayed over 2 hours, contact support.`
      
      await sendSMS({
        phone: phoneNumber,
        message: smsMessage,
        type: 'data_purchase_success',
        reference: order[0].id,
      }).catch(err => console.error("[SMS] SMS error:", err))
    } catch (smsError) {
      console.warn("[SMS] Failed to send purchase SMS:", smsError)
      // Don't fail the purchase if SMS fails
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
