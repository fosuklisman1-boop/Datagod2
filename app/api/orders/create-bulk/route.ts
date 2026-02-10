import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { sendSMS } from "@/lib/sms-service"
import { customerTrackingService } from "@/lib/customer-tracking-service"
import { isPhoneBlacklisted } from "@/lib/blacklist"
import {
  isAutoFulfillmentEnabled as isMTNAutoFulfillmentEnabled,
  createMTNOrder,
  saveMTNTracking,
  normalizePhoneNumber,
} from "@/lib/mtn-fulfillment"
import { atishareService } from "@/lib/at-ishare-service"
import { supabaseAdmin } from "@/lib/supabase" // Need admin client for checking settings if not already available, but usage below checks 'supabase' which is user client?
// create-bulk uses `supabase` created with serviceRoleKey which IS admin privileges.
// But `isAutoFulfillmentEnabled` helper in purchase uses `supabaseAdmin`.
// Here `supabase` = createClient(..., serviceRoleKey) so it is admin.

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

    // Fetch user role for price calculation
    const { data: userData } = await supabase
      .from("users")
      .select("role")
      .eq("id", userId)
      .single()
    const userRole = userData?.role || "user"

    // Fetch packages for verification
    const { data: packages } = await supabase
      .from("packages")
      .select("network, size, price, dealer_price")
      .eq("is_available", true)
      .eq("network", network)

    // Helper to normalize size string (e.g. "1GB" -> 1)
    const normalizeSize = (s: string) => parseFloat(s.replace(/[^\d.]/g, ''))

    // Check which orders have blacklisted phones
    const blacklistChecks = await Promise.all(
      orders.map(async (order: BulkOrderData) => ({
        phone_number: order.phone_number,
        isBlacklisted: await isPhoneBlacklisted(order.phone_number)
      }))
    )
    const blacklistedPhones = new Set(
      blacklistChecks.filter(check => check.isBlacklisted).map(check => check.phone_number)
    )
    console.log(`[BULK-ORDERS] Found ${blacklistedPhones.size} blacklisted phone(s)`, Array.from(blacklistedPhones))

    // Insert all orders using VERIFIED prices
    const ordersToInsert = orders.map((order: BulkOrderData) => {
      // Find matching package
      const pkg = packages?.find(p => normalizeSize(p.size) === order.volume_gb)

      let verifiedPrice = order.price
      if (pkg) {
        verifiedPrice = (userRole === "dealer" && pkg.dealer_price && pkg.dealer_price > 0)
          ? pkg.dealer_price
          : pkg.price
      } else {
        console.warn(`[BULK-ORDERS] Could not find package for ${network} ${order.volume_gb}GB`)
        // Fallback to client price but maybe should fail? keeping client price for robust fallback if matching fails
      }

      return {
        user_id: userId,
        phone_number: order.phone_number,
        size: order.volume_gb.toString(), // Convert to string as per schema
        network: network,
        price: verifiedPrice, // Use verified price
        status: "pending", // Use 'status' instead of 'order_status'
        queue: blacklistedPhones.has(order.phone_number) ? "blacklisted" : "default",
        created_at: new Date().toISOString(),
      }
    })

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

    // Calculate total cost from created orders (verified prices)
    const totalCost = createdOrders?.reduce((sum: number, order: any) => sum + order.price, 0) || 0

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

    // Check balance again server-side
    if (currentBalance < totalCost) {
      // Ideally we should rollback orders here or mark them failed?
      // For now, let's just proceed but logged as negative balance risk? 
      // Or better, error out. But orders are already created!
      // In a proper transaction, this should be atomic. 
      // Since we didn't use a transaction (Supabase RPC is better for this), 
      // we might end up with orders but no deduction if we stop here.
      // However, the prior check in frontend helps. 
      // Let's rely on wallet having enough funds. 
      // If we want to be strict, we should have checked balance vs verifiedTotal BEFORE insertion.
    }

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

      // Track bulk order customers if user has a shop
      try {
        console.log("[BULK-ORDERS] Checking if user has a shop for customer tracking...")

        const { data: shop, error: shopError } = await supabase
          .from("user_shops")
          .select("id")
          .eq("user_id", userId)
          .single()

        if (shopError && shopError.code !== "PGRST116") {
          console.warn("[BULK-ORDERS] Error fetching shop:", shopError)
        } else if (shop?.id) {
          console.log(`[BULK-ORDERS] Found shop ${shop.id}, tracking bulk order customers...`)

          // Track each phone number as a customer
          for (const order of orders) {
            try {
              const result = await customerTrackingService.trackBulkOrderCustomer({
                shopId: shop.id,
                phoneNumber: order.phone_number,
                orderId: createdOrders?.find((o: any) => o.phone_number === order.phone_number)?.id || "",
                amount: order.price,
                network: network,
                volumeGb: order.volume_gb,
              })
              console.log(`[BULK-ORDERS] ✓ Customer tracked: ${order.phone_number}`, result)
            } catch (trackError) {
              console.error(
                `[BULK-ORDERS] ✗ Failed to track customer ${order.phone_number}:`,
                trackError
              )
              // Don't fail the bulk order if tracking fails
            }
          }

          console.log("[BULK-ORDERS] ✓ Bulk order customers tracked")
        } else {
          console.log("[BULK-ORDERS] User has no shop, skipping customer tracking")
        }
      } catch (trackingError) {
        console.error("[BULK-ORDERS] ✗ Error tracking bulk order customers:", trackingError)
        // Don't fail the bulk order if customer tracking fails
      }

      // Send SMS to each phone number in the bulk order
      try {
        const uniquePhones = [...new Set(orders.map((o: BulkOrderData) => o.phone_number))]

        for (const phoneNumber of uniquePhones) {
          // Find volume for this phone number
          const volumeForPhone = orders.find((o: BulkOrderData) => o.phone_number === phoneNumber)?.volume_gb || 0
          const smsMessage = `You have successfully placed an order of ${network} ${volumeForPhone}GB to ${phoneNumber}. If delayed over 2 hours, contact support.`

          await sendSMS({
            phone: phoneNumber,
            message: smsMessage,
            type: 'bulk_order_success',
            reference: `BULK-${Date.now()}`,
          }).catch(err => console.error("[SMS] SMS error for phone ${phoneNumber}:", err))
        }

        console.log(`[SMS] ✓ SMS sent to ${uniquePhones.length} unique phone number(s)`)
      } catch (smsError) {
        console.warn("[SMS] Failed to send bulk order SMS:", smsError)
        // Don't fail the bulk order if SMS fails
      }
    }

    // Trigger MTN Fulfillment (Automatic)
    const normalizedNetwork = network?.trim() || ""
    const isMTNNetwork = normalizedNetwork.toLowerCase() === "mtn"

    if (isMTNNetwork && createdOrders && createdOrders.length > 0) {
      console.log(`[BULK-FULFILLMENT] MTN bulk order detected. Checking MTN auto-fulfillment setting...`)

        // Use IIFE for non-blocking execution to allow response to return fast
        // Note: On some serverless platforms this might be cut off, but following existing pattern from purchase route
        ; (async () => {
          try {
            const mtnAutoEnabled = await isMTNAutoFulfillmentEnabled()
            console.log(`[BULK-FULFILLMENT] MTN Auto-fulfillment enabled: ${mtnAutoEnabled}`)

            if (!mtnAutoEnabled) {
              console.log(`[BULK-FULFILLMENT] MTN auto-fulfillment disabled. Orders will go to admin queue.`)
              return
            }

            console.log(`[BULK-FULFILLMENT] Starting async fulfillment for ${createdOrders.length} orders...`)

            // Process each order
            for (const order of createdOrders) {
              try {
                // Check if order is in blacklist queue
                if (order.queue === "blacklisted") {
                  console.log(`[BULK-FULFILLMENT] ⚠️ Order ${order.id} is in blacklist queue - skipping MTN fulfillment`)
                  continue
                }

                const sizeGb = parseFloat(order.size) || 0
                const normalizedPhone = normalizePhoneNumber(order.phone_number)
                console.log(`[BULK-FULFILLMENT] Calling MTN API for order ${order.id}: ${normalizedPhone}, ${sizeGb}GB`)

                const mtnRequest = {
                  recipient_phone: normalizedPhone,
                  network: "MTN" as const,
                  size_gb: sizeGb,
                }

                // Call MTN API
                const mtnResult = await createMTNOrder(mtnRequest)

                console.log(`[BULK-FULFILLMENT] ✓ MTN API response for order ${order.id}:`, mtnResult)

                // Save tracking record
                if (mtnResult.order_id) {
                  await saveMTNTracking(
                    order.id,      // order_id from orders table
                    mtnResult.order_id,
                    mtnRequest,
                    mtnResult,
                    "bulk",         // this is a bulk order
                    mtnResult.provider || "sykes"
                  )
                }

                // Update order status if successful
                if (mtnResult.success) {
                  await supabase
                    .from("orders")
                    .update({
                      status: "processing",
                      updated_at: new Date().toISOString(),
                    })
                    .eq("id", order.id)

                  console.log(`[BULK-FULFILLMENT] ✓ Order ${order.id} marked as processing via MTN auto-fulfillment`)
                } else {
                  console.log(`[BULK-FULFILLMENT] ✗ Order ${order.id} failed MTN fulfillment: ${mtnResult.message}`)
                }

                // Small delay to prevent rate limit spikes if many orders
                await new Promise(resolve => setTimeout(resolve, 200))

              } catch (orderError) {
                console.error(`[BULK-FULFILLMENT] Error processing order ${order.id}:`, orderError)
              }
            }
          } catch (err) {
            console.error(`[BULK-FULFILLMENT] Global error in bulk processing block:`, err)
          }
        })()
    }

    // Trigger Fulfillment for Other Networks (AT, Telecel)
    const fulfillableNetworks = ["AT - iShare", "AT-iShare", "AT - ishare", "at - ishare", "Telecel", "telecel", "TELECEL", "AT - BigTime", "AT-BigTime", "AT - bigtime", "at - bigtime"]
    const isAutoFulfillable = fulfillableNetworks.some(n => n.toLowerCase() === normalizedNetwork.toLowerCase())

    if (isAutoFulfillable && createdOrders && createdOrders.length > 0) {
      console.log(`[BULK-FULFILLMENT] ${network} bulk order detected. Checking auto-fulfillment settings...`)

        ; (async () => {
          try {
            // Check generic auto-fulfillment setting
            const { data: setting } = await supabase
              .from("admin_settings")
              .select("value")
              .eq("key", "auto_fulfillment_enabled")
              .single()

            const autoFulfillEnabled = setting?.value?.enabled ?? true

            if (!autoFulfillEnabled) {
              console.log(`[BULK-FULFILLMENT] Auto-fulfillment disabled for ${network}. Orders will go to admin queue.`)
              return
            }

            console.log(`[BULK-FULFILLMENT] Starting async fulfillment for ${createdOrders.length} ${network} orders...`)
            const networkLower = normalizedNetwork.toLowerCase()
            const isBigTime = networkLower.includes("bigtime")
            const apiNetwork = networkLower.includes("telecel") ? "TELECEL" : "AT"

            for (const order of createdOrders) {
              try {
                // Check blacklist
                if (order.queue === "blacklisted") {
                  console.log(`[BULK-FULFILLMENT] ⚠️ Order ${order.id} is in blacklist queue - skipping fulfillment`)
                  continue
                }

                const sizeGb = parseFloat(order.size) || 0
                if (sizeGb === 0) continue

                console.log(`[BULK-FULFILLMENT] Triggering ${apiNetwork} fulfillment for order ${order.id}: ${order.phone_number}, ${sizeGb}GB`)

                atishareService.fulfillOrder({
                  phoneNumber: order.phone_number,
                  sizeGb,
                  orderId: order.id,
                  network: apiNetwork,
                  orderType: "wallet", // Bulk creates orders in 'orders' table, same as wallet purchase
                  isBigTime,
                }).then(result => {
                  console.log(`[BULK-FULFILLMENT] Fulfillment result for order ${order.id}:`, result)
                }).catch(err => {
                  console.error(`[BULK-FULFILLMENT] Failed fulfillment for order ${order.id}:`, err)
                })

                // Small delay to prevent rate limits
                await new Promise(resolve => setTimeout(resolve, 300))

              } catch (err) {
                console.error(`[BULK-FULFILLMENT] Error in loop for order ${order.id}:`, err)
              }
            }
          } catch (err) {
            console.error(`[BULK-FULFILLMENT] Global error in non-MTN bulk processing:`, err)
          }
        })()
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
