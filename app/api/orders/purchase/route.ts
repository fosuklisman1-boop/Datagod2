import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { notificationTemplates } from "@/lib/notification-service"
import { sendSMS } from "@/lib/sms-service"
import { customerTrackingService } from "@/lib/customer-tracking-service"
import { atishareService } from "@/lib/at-ishare-service"
import { isPhoneBlacklisted } from "@/lib/blacklist"
import {
  isAutoFulfillmentEnabled as isMTNAutoFulfillmentEnabled,
  createMTNOrder,
  saveMTNTracking,
  normalizePhoneNumber,
} from "@/lib/mtn-fulfillment"

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
    let userEmail = user.email // Email from auth user object

    // If email not in auth object, fetch from users table
    if (!userEmail) {
      const { data: userData } = await supabaseAdmin
        .from("users")
        .select("email")
        .eq("id", userId)
        .single()
      userEmail = userData?.email || undefined
    }

    console.log(`[PURCHASE] User ID: ${userId}, Email: ${userEmail || "NOT FOUND"}`)

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

    // Check if phone is blacklisted
    let phoneQueue = "default"
    let orderStatus = "pending"
    try {
      const isBlacklisted = await isPhoneBlacklisted(phoneNumber)
      if (isBlacklisted) {
        phoneQueue = "blacklisted"
        orderStatus = "blacklisted"
        console.log(`[PURCHASE] Phone ${phoneNumber} is blacklisted - setting queue to 'blacklisted' and status to 'blacklisted'`)
      }
    } catch (blacklistError) {
      console.warn("[PURCHASE] Error checking blacklist:", blacklistError)
      // Continue with default queue if blacklist check fails
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
          status: orderStatus,
          queue: phoneQueue,
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

    // Trigger fulfillment for AT-iShare, Telecel, and AT-BigTime orders (auto-fulfilled via Code Craft API)
    // Only if auto-fulfillment is enabled in admin settings
    const fulfillableNetworks = ["AT - iShare", "AT-iShare", "AT - ishare", "at - ishare", "Telecel", "telecel", "TELECEL", "AT - BigTime", "AT-BigTime", "AT - bigtime", "at - bigtime"]
    const normalizedNetwork = network?.trim() || ""
    const isAutoFulfillable = fulfillableNetworks.some(n => n.toLowerCase() === normalizedNetwork.toLowerCase())
    
    // Check if auto-fulfillment is enabled
    const autoFulfillEnabled = await isAutoFulfillmentEnabled()
    const shouldFulfill = isAutoFulfillable && autoFulfillEnabled
    
    console.log(`[FULFILLMENT] Network received: "${network}" | Auto-fulfillable: ${isAutoFulfillable} | Auto-fulfill enabled: ${autoFulfillEnabled} | Should fulfill: ${shouldFulfill} | Order: ${order[0].id}`)
    
    if (shouldFulfill) {
      try {
        console.log(`[FULFILLMENT] Starting fulfillment trigger for ${network} order ${order[0].id} to ${phoneNumber}`)
        console.log(`[FULFILLMENT] Raw size value:`, size, `(type: ${typeof size})`)
        
        // Parse size - handle different formats: "100GB", "100", 100, etc.
        let sizeGb = 0
        if (typeof size === "number") {
          sizeGb = size
        } else if (typeof size === "string") {
          // Extract digits from string like "100GB", "100 GB", etc.
          const digits = size.replace(/[^0-9]/g, "")
          sizeGb = parseInt(digits) || 0
        }
        
        // If size is still 0, try to fetch from package
        if (sizeGb === 0 && packageId) {
          console.log(`[FULFILLMENT] ⚠️ Size is 0, attempting to fetch from package ${packageId}`)
          const { data: pkgData } = await supabaseAdmin
            .from("data_packages")
            .select("size")
            .eq("id", packageId)
            .single()
          if (pkgData?.size) {
            const pkgDigits = pkgData.size.toString().replace(/[^0-9]/g, "")
            sizeGb = parseInt(pkgDigits) || 0
            console.log(`[FULFILLMENT] ✓ Got size from package: ${sizeGb}GB`)
          }
        }
        
        console.log(`[FULFILLMENT] Order details - Network: ${network}, Size: ${sizeGb}GB, Phone: ${phoneNumber}, OrderID: ${order[0].id}`)
        
        // Determine API network and endpoint based on order network
        const networkLower = normalizedNetwork.toLowerCase()
        const isBigTime = networkLower.includes("bigtime")
        const apiNetwork = networkLower.includes("telecel") ? "TELECEL" : "AT"
        
        // Non-blocking fulfillment trigger
        console.log(`[FULFILLMENT] Calling atishareService.fulfillOrder with network: ${apiNetwork}, isBigTime: ${isBigTime}`)
        atishareService.fulfillOrder({
          phoneNumber,
          sizeGb,
          orderId: order[0].id,
          network: apiNetwork,
          orderType: "wallet",  // Wallet orders use orders table
          isBigTime,
          customer_email: isBigTime ? userEmail : undefined,
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

    // Handle MTN fulfillment separately via MTN API (Sykes Official)
    const isMTNNetwork = normalizedNetwork.toLowerCase() === "mtn"
    if (isMTNNetwork) {
      console.log(`[FULFILLMENT] MTN order detected. Checking MTN auto-fulfillment setting...`)
      const mtnAutoEnabled = await isMTNAutoFulfillmentEnabled()
      console.log(`[FULFILLMENT] MTN Auto-fulfillment enabled: ${mtnAutoEnabled}`)
      
      if (mtnAutoEnabled) {
        // Non-blocking MTN fulfillment
        (async () => {
          try {
            // Check if order is in blacklist queue
            if (order[0].queue === "blacklisted") {
              console.log(`[FULFILLMENT] ⚠️ Order ${order[0].id} is in blacklist queue - skipping MTN fulfillment`)
              return
            }

            // Secondary check: verify phone number against blacklist
            try {
              const isBlacklisted = await isPhoneBlacklisted(phoneNumber)
              if (isBlacklisted) {
                console.log(`[FULFILLMENT] ⚠️ Phone ${phoneNumber} is blacklisted - skipping MTN fulfillment`)
                return
              }
            } catch (blacklistError) {
              console.warn("[FULFILLMENT] Error checking blacklist:", blacklistError)
              // Continue if blacklist check fails
            }

            const sizeGb = parseInt(size.toString().replace(/[^0-9]/g, "")) || 0
            const normalizedPhone = normalizePhoneNumber(phoneNumber)
            console.log(`[FULFILLMENT] Calling MTN API for order ${order[0].id}: ${normalizedPhone}, ${sizeGb}GB`)
            
            const mtnRequest = {
              recipient_phone: normalizedPhone,
              network: "MTN" as const,
              size_gb: sizeGb,
            }
            const mtnResult = await createMTNOrder(mtnRequest)
            
            console.log(`[FULFILLMENT] ✓ MTN API response for order ${order[0].id}:`, mtnResult)
            
            // Save tracking record (bulk order type since this is from orders table)
            if (mtnResult.order_id) {
              await saveMTNTracking(
                order[0].id,
                mtnResult.order_id,
                mtnRequest,
                mtnResult,
                "bulk"  // This is a bulk order from the data packages page
              )
            }
            
            // Update order status
            if (mtnResult.success) {
              await supabaseAdmin
                .from("orders")
                .update({
                  status: "processing",
                  updated_at: new Date().toISOString(),
                })
                .eq("id", order[0].id)
              console.log(`[FULFILLMENT] ✓ Order ${order[0].id} marked as processing via MTN auto-fulfillment`)
            }
          } catch (err) {
            console.error(`[FULFILLMENT] ❌ MTN fulfillment error for order ${order[0].id}:`, err)
          }
        })()
      } else {
        console.log(`[FULFILLMENT] MTN auto-fulfillment disabled. Order ${order[0].id} will go to admin queue.`)
      }
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

    // Send blacklist notification SMS if order was blacklisted
    if (orderStatus === "blacklisted") {
      try {
        const blacklistSMS = `DATAGOD: Your order for ${network} ${size}GB to ${phoneNumber} has been created. However, this number is blacklisted and your order will not be fulfilled. Contact support for assistance.`
        await sendSMS({
          phone: phoneNumber,
          message: blacklistSMS,
          type: 'order_blacklisted',
          reference: order[0].id,
        }).catch(err => console.error("[SMS] Blacklist SMS error:", err))
        console.log("[PURCHASE] ✓ Blacklist notification SMS sent to", phoneNumber)
      } catch (smsError) {
        console.warn("[PURCHASE] Failed to send blacklist notification SMS:", smsError)
      }

      // Send admin notification
      try {
        const { data: userShop } = await supabaseAdmin
          .from("user_shops")
          .select("user_id")
          .eq("user_id", userId)
          .single()

        if (userShop?.user_id) {
          const { data: shopOwner } = await supabaseAdmin
            .from("users")
            .select("phone_number")
            .eq("id", userShop.user_id)
            .single()

          if (shopOwner?.phone_number) {
            const adminSMS = `[ALERT] DATAGOD: Order ${order[0].id.substring(0, 8)} from blacklisted number ${phoneNumber} attempted to purchase. Order blocked.`
            await sendSMS({
              phone: shopOwner.phone_number,
              message: adminSMS,
              type: 'admin_alert',
              reference: order[0].id,
            }).catch(err => console.error("[SMS] Admin SMS error:", err))
            console.log("[PURCHASE] ✓ Admin alert SMS sent to", shopOwner.phone_number)
          }
        }
      } catch (adminError) {
        console.warn("[PURCHASE] Failed to send admin alert SMS:", adminError)
      }
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
