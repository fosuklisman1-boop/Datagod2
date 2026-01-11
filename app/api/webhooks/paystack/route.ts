import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import crypto from "crypto"
import { notificationTemplates } from "@/lib/notification-service"
import { sendSMS } from "@/lib/sms-service"
import { atishareService } from "@/lib/at-ishare-service"
import { customerTrackingService } from "@/lib/customer-tracking-service"
import { isPhoneBlacklisted } from "@/lib/blacklist"
import {
  isAutoFulfillmentEnabled as isMTNAutoFulfillmentEnabled,
  createMTNOrder,
  saveMTNTracking,
  normalizePhoneNumber,
} from "@/lib/mtn-fulfillment"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * Check if auto-fulfillment is enabled in admin settings
 */
async function isAutoFulfillmentEnabled(): Promise<boolean> {
  try {
    const { data, error } = await supabase
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
    console.warn("[WEBHOOK] Error checking auto-fulfillment setting:", error)
    // Default to enabled on error
    return true
  }
}

/**
 * Webhook endpoint for Paystack payment notifications
 * Configure this URL in your Paystack dashboard settings
 */
export async function POST(request: NextRequest) {
  console.log("[WEBHOOK] ========== WEBHOOK CALLED ==========")
  try {
    const signature = request.headers.get("x-paystack-signature")
    console.log("[WEBHOOK] Request headers:", {
      signature: !!signature,
      contentType: request.headers.get("content-type"),
    })

    if (!signature) {
      console.warn("[WEBHOOK] Missing signature")
      return NextResponse.json(
        { error: "Invalid request: missing signature" },
        { status: 401 }
      )
    }

    const body = await request.text()
    const hash = crypto.createHmac("sha512", paystackSecretKey).update(body).digest("hex")
    console.log("[WEBHOOK] Signature verified:", hash === signature)

    if (hash !== signature) {
      console.warn("[WEBHOOK] Invalid signature")
      return NextResponse.json(
        { error: "Invalid signature" },
        { status: 401 }
      )
    }

    const event = JSON.parse(body)
    console.log("[WEBHOOK] Event type:", event.event)

    // Handle charge.success event
    if (event.event === "charge.success") {
      const { reference, customer, amount, status } = event.data

      console.log(`Processing payment: ${reference}`, {
        email: customer.email,
        amount: amount / 100,
        status,
      })

      // Find and update payment record (select only needed columns)
      const { data: paymentData, error: fetchError } = await supabase
        .from("wallet_payments")
        .select("id, user_id, status, shop_id, order_id, fee, reference")
        .eq("reference", reference)
        .single()

      if (fetchError) {
        console.error("Payment record not found:", fetchError)
        return NextResponse.json(
          { error: "Payment record not found" },
          { status: 404 }
        )
      }

      // Update payment status
      const { error: updateError } = await supabase
        .from("wallet_payments")
        .update({
          status: "completed",
          amount_received: amount / 100,
          paystack_transaction_id: event.data.id,
          updated_at: new Date().toISOString(),
        })
        .eq("id", paymentData.id)

      if (updateError) {
        console.error("Error updating payment:", updateError)
        throw updateError
      }

      // Update payment_attempts to completed (non-blocking)
      supabase
        .from("payment_attempts")
        .update({
          status: "completed",
          paystack_transaction_id: event.data.id,
          gateway_response: event.data.gateway_response || "success",
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("reference", reference)
        .then(({ error }) => {
          if (error) console.warn("[WEBHOOK] Failed to update payment_attempts:", error.message)
          else console.log("[WEBHOOK] ✓ payment_attempts updated to completed")
        })

      // IMPORTANT: Check if payment was already processed to prevent double crediting
      // If status was already "completed" before this webhook, skip crediting
      const wasAlreadyCompleted = paymentData.status === "completed"
      
      if (wasAlreadyCompleted) {
        console.log(`[WEBHOOK] ⚠️ Payment already processed (status was: ${paymentData.status}). Skipping duplicate credit.`)
        return NextResponse.json({ received: true, skipped: "already_processed" })
      }

      // If this is a shop order payment, update shop_orders payment status and create profit record
      if (paymentData.order_id && paymentData.shop_id) {
        console.log(`[WEBHOOK] Updating shop order payment status for order: ${paymentData.order_id}`)
        
        // Get shop order details to create profit record and track customer
        const { data: shopOrderData, error: orderFetchError } = await supabase
          .from("shop_orders")
          .select("id, shop_id, profit_amount, customer_phone, customer_email, customer_name, network, volume_gb, total_price, reference_code, parent_shop_id, parent_profit_amount, queue")
          .eq("id", paymentData.order_id)
          .single()

        console.log("[WEBHOOK] Shop order data fetched:", {
          id: shopOrderData?.id,
          parent_shop_id: shopOrderData?.parent_shop_id,
          parent_profit_amount: shopOrderData?.parent_profit_amount,
          profit_amount: shopOrderData?.profit_amount
        })

        if (orderFetchError) {
          console.error("Error fetching shop order:", orderFetchError)
        } else {
          // Update shop order payment status
          const { error: shopOrderError } = await supabase
            .from("shop_orders")
            .update({
              payment_status: "completed",
              transaction_id: event.data.id,
              updated_at: new Date().toISOString(),
            })
            .eq("id", paymentData.order_id)

          if (shopOrderError) {
            console.error("Error updating shop order payment status:", shopOrderError)
          } else {
            console.log(`[WEBHOOK] ✓ Shop order ${paymentData.order_id} payment status updated to completed`)
            
            // Track customer NOW that payment is confirmed
            // This prevents inflated customer revenue from abandoned orders
            try {
              const trackingResult = await customerTrackingService.trackCustomer({
                shopId: shopOrderData.shop_id,
                phoneNumber: shopOrderData.customer_phone,
                email: shopOrderData.customer_email || "",
                customerName: shopOrderData.customer_name || "Customer",
                totalPrice: shopOrderData.total_price,
                slug: "storefront",
                orderId: paymentData.order_id,
              })
              
              // Update shop_orders with the customer ID
              if (trackingResult?.customerId) {
                await supabase
                  .from("shop_orders")
                  .update({ shop_customer_id: trackingResult.customerId })
                  .eq("id", paymentData.order_id)
                
                console.log(`[WEBHOOK] ✓ Customer tracked: ${trackingResult.customerId}, Repeat: ${trackingResult.isRepeatCustomer}`)
              }
            } catch (trackingError) {
              console.error("[WEBHOOK] Customer tracking error (non-blocking):", trackingError)
              // Continue without tracking if it fails
            }
            
            // Send SMS to customer about payment confirmation
            if (shopOrderData?.customer_phone) {
              // Don't send payment confirmation SMS if order is blacklisted
              if (shopOrderData?.queue === "blacklisted") {
                console.log(`[WEBHOOK] ⚠️ Order ${paymentData.order_id} is blacklisted - skipping payment confirmation SMS`)
              } else {
                try {
                  // Get shop name from shop_orders table
                  const { data: shopDetailsData, error: shopDetailsError } = await supabase
                    .from("user_shops")
                    .select("shop_name, user_id")
                    .eq("id", paymentData.shop_id)
                    .single()
                  
                  let shopName = shopDetailsData?.shop_name || "Shop"
                  let shopOwnerPhone = "Support"
                  
                  // If shop found, fetch owner's phone number from users table
                  if (shopDetailsData?.user_id) {
                    const { data: ownerData, error: ownerError } = await supabase
                      .from("users")
                      .select("phone_number")
                      .eq("id", shopDetailsData.user_id)
                      .single()
                    
                    if (ownerData?.phone_number) {
                      shopOwnerPhone = ownerData.phone_number
                    }
                  }
                  
                  const smsMessage = `${shopName}: You have successfully placed an order of ${shopOrderData.network} ${shopOrderData.volume_gb}GB to ${shopOrderData.customer_phone}. If delayed over 2 hours, contact shop owner: ${shopOwnerPhone}`
                  
                  await sendSMS({
                    phone: shopOrderData.customer_phone,
                    message: smsMessage,
                    type: 'order_payment_confirmed',
                    reference: paymentData.order_id,
                  }).catch(err => console.error("[WEBHOOK] SMS error:", err))
                } catch (smsError) {
                  console.warn("[WEBHOOK] SMS notification failed:", smsError)
                }
              }
            }

            // Trigger Code Craft fulfillment for shop orders (AT-iShare, Telecel, AT-BigTime)
            // Only if auto-fulfillment is enabled in admin settings
            const fulfillableNetworks = ["AT - iShare", "AT-iShare", "AT - ishare", "at - ishare", "Telecel", "telecel", "TELECEL", "AT - BigTime", "AT-BigTime", "AT - bigtime", "at - bigtime"]
            const networkLower = (shopOrderData?.network || "").toLowerCase()
            const isAutoFulfillable = fulfillableNetworks.some(n => n.toLowerCase() === networkLower)
            
            // Check if auto-fulfillment is enabled
            const autoFulfillEnabled = await isAutoFulfillmentEnabled()
            const shouldFulfill = isAutoFulfillable && autoFulfillEnabled
            
            console.log(`[WEBHOOK] Shop order network: "${shopOrderData?.network}" | Auto-fulfillable: ${isAutoFulfillable} | Auto-fulfill enabled: ${autoFulfillEnabled} | Should fulfill: ${shouldFulfill}`)
            
            if (shouldFulfill && shopOrderData?.customer_phone) {
              // Check if order is in blacklist queue
              if (shopOrderData?.queue === "blacklisted") {
                console.log(`[WEBHOOK] ⚠️ Order ${paymentData.order_id} is in blacklist queue - skipping Code Craft fulfillment`)
              } else {
                console.log(`[WEBHOOK] Triggering Code Craft fulfillment for shop order ${paymentData.order_id}`)
              console.log(`[WEBHOOK] Raw volume_gb value:`, shopOrderData.volume_gb, `(type: ${typeof shopOrderData.volume_gb})`)
              
              // Parse size - handle different formats
              let sizeGb = 0
              if (typeof shopOrderData.volume_gb === "number") {
                sizeGb = shopOrderData.volume_gb
              } else if (shopOrderData.volume_gb) {
                const digits = shopOrderData.volume_gb.toString().replace(/[^0-9]/g, "")
                sizeGb = parseInt(digits) || 0
              }
              
              if (sizeGb === 0) {
                console.error(`[WEBHOOK] ❌ Could not determine size for shop order ${paymentData.order_id}, skipping fulfillment`)
              }
              
              // Determine the network and endpoint for Code Craft API
              const isBigTime = networkLower.includes("bigtime")
              const apiNetwork = networkLower.includes("telecel") ? "TELECEL" : "AT"
              
              // Non-blocking fulfillment trigger
              atishareService.fulfillOrder({
                phoneNumber: shopOrderData.customer_phone,
                sizeGb,
                orderId: paymentData.order_id,
                network: apiNetwork,
                orderType: "shop",
                isBigTime,
                customer_email: isBigTime ? shopOrderData.customer_email : undefined,
              }).then(result => {
                console.log(`[WEBHOOK] ✓ Fulfillment triggered for shop order ${paymentData.order_id}:`, result)
              }).catch(err => {
                console.error(`[WEBHOOK] ❌ Error triggering fulfillment for shop order ${paymentData.order_id}:`, err)
              })
              }
            } else if (isAutoFulfillable && !autoFulfillEnabled) {
              console.log(`[WEBHOOK] ℹ Auto-fulfillment disabled. Shop order ${paymentData.order_id} will go to admin queue.`)
            } else if (shouldFulfill && !shopOrderData?.customer_phone) {
              console.error(`[WEBHOOK] ❌ Cannot fulfill shop order ${paymentData.order_id}: No customer_phone`)
            }

            // Handle MTN fulfillment directly via MTN API (not HTTP fetch)
            const isMTNNetwork = networkLower === "mtn"
            if (isMTNNetwork && shopOrderData?.customer_phone) {
              console.log(`[WEBHOOK] MTN order detected. Processing MTN fulfillment for shop order ${paymentData.order_id}`)
              const sizeGb = parseInt(shopOrderData.volume_gb?.toString().replace(/[^0-9]/g, "") || "0") || 0
              const normalizedPhone = normalizePhoneNumber(shopOrderData.customer_phone)
              
              // Check if MTN auto-fulfillment is enabled
              const mtnAutoEnabled = await isMTNAutoFulfillmentEnabled()
              console.log(`[WEBHOOK] MTN Auto-fulfillment enabled: ${mtnAutoEnabled}`)
              
              if (mtnAutoEnabled) {
                // Non-blocking MTN fulfillment via direct API call
                (async () => {
                  try {
                    // Check if order is in blacklist queue
                    if (shopOrderData?.queue === "blacklisted") {
                      console.log(`[WEBHOOK] ⚠️ Order ${paymentData.order_id} is in blacklist queue - skipping MTN fulfillment`)
                      return
                    }

                    // Secondary check: verify phone number against blacklist
                    try {
                      const { isPhoneBlacklisted } = await import("@/lib/blacklist")
                      const isBlacklisted = await isPhoneBlacklisted(shopOrderData?.customer_phone)
                      if (isBlacklisted) {
                        console.log(`[WEBHOOK] ⚠️ Phone ${shopOrderData?.customer_phone} is blacklisted - skipping MTN fulfillment`)
                        return
                      }
                    } catch (blacklistError) {
                      console.warn("[WEBHOOK] Error checking blacklist:", blacklistError)
                      // Continue if blacklist check fails
                    }

                    console.log(`[WEBHOOK] Calling MTN API for shop order ${paymentData.order_id}: ${normalizedPhone}, ${sizeGb}GB`)
                    const mtnRequest = {
                      recipient_phone: normalizedPhone,
                      network: "MTN" as const,
                      size_gb: sizeGb,
                    }
                    const mtnResult = await createMTNOrder(mtnRequest)
                    
                    console.log(`[WEBHOOK] ✓ MTN API response for shop order ${paymentData.order_id}:`, mtnResult)
                    
                    // Save tracking record
                    if (mtnResult.order_id) {
                      await saveMTNTracking(
                        paymentData.order_id,
                        mtnResult.order_id,
                        mtnRequest,
                        mtnResult,
                        "shop"  // Storefront order via Paystack
                      )
                    }
                    
                    // Update shop order status
                    if (mtnResult.success) {
                      await supabase
                        .from("shop_orders")
                        .update({
                          order_status: "processing",
                          fulfillment_method: "auto_mtn",
                          updated_at: new Date().toISOString(),
                        })
                        .eq("id", paymentData.order_id)
                      console.log(`[WEBHOOK] ✓ Shop order ${paymentData.order_id} marked as processing via MTN auto-fulfillment`)
                    }
                  } catch (err) {
                    console.error(`[WEBHOOK] ❌ MTN fulfillment error for shop order ${paymentData.order_id}:`, err)
                  }
                })()
              } else {
                console.log(`[WEBHOOK] MTN auto-fulfillment disabled. Order ${paymentData.order_id} will be processed manually.`)
              }
            }
          }

          // Check if phone is blacklisted and send notification SMS
          if (shopOrderData?.customer_phone) {
            try {
              const isBlacklisted = await isPhoneBlacklisted(shopOrderData.customer_phone)
              if (isBlacklisted) {
                console.log(`[WEBHOOK] ⚠️ Phone ${shopOrderData.customer_phone} is blacklisted - sending blacklist notification`)
                const blacklistSMS = `DATAGOD: Your payment has been confirmed for ${shopOrderData.network} ${shopOrderData.volume_gb}GB to ${shopOrderData.customer_phone}. However, this number is blacklisted and your order will not be fulfilled. Contact support for assistance.`
                
                await sendSMS({
                  phone: shopOrderData.customer_phone,
                  message: blacklistSMS,
                  type: 'order_blacklisted',
                  reference: paymentData.order_id,
                }).catch(err => console.error("[WEBHOOK] Blacklist notification SMS error:", err))
              }
            } catch (blacklistError) {
              console.warn("[WEBHOOK] Error checking blacklist after payment:", blacklistError)
              // Continue - don't fail webhook if blacklist check fails
            }
          }

          // Create shop profit record for the sub-agent/shop owner
          if (shopOrderData?.profit_amount > 0) {
            // Get current balance before adding this profit
            const { data: existingProfits } = await supabase
              .from("shop_profits")
              .select("profit_amount, status")
              .eq("shop_id", paymentData.shop_id)
            
            const balanceBefore = existingProfits?.reduce((sum: number, p: any) => {
              if (p.status === "pending" || p.status === "credited") {
                return sum + (p.profit_amount || 0)
              }
              return sum
            }, 0) || 0
            const balanceAfter = balanceBefore + shopOrderData.profit_amount

            const { error: profitError } = await supabase
              .from("shop_profits")
              .insert([
                {
                  shop_id: paymentData.shop_id,
                  shop_order_id: paymentData.order_id,
                  profit_amount: shopOrderData.profit_amount,
                  profit_balance_before: balanceBefore,
                  profit_balance_after: balanceAfter,
                  status: "credited",
                  created_at: new Date().toISOString(),
                }
              ])

            if (profitError) {
              console.error("Error creating shop profit record:", profitError)
            } else {
              console.log(`[WEBHOOK] ✓ Shop profit record created: GHS ${shopOrderData.profit_amount.toFixed(2)}`)
              
              // Sync available balance after creating profit
              try {
                // Get all profits to calculate available balance
                const { data: profits, error: profitFetchError } = await supabase
                  .from("shop_profits")
                  .select("profit_amount, status")
                  .eq("shop_id", paymentData.shop_id)
                  .select("profit_amount, status")
                  .eq("shop_id", paymentData.shop_id)

                if (!profitFetchError && profits) {
                  // Calculate totals by status
                  const breakdown = {
                    totalProfit: 0,
                    creditedProfit: 0,
                    withdrawnProfit: 0,
                  }

                  profits.forEach((p: any) => {
                    const amount = p.profit_amount || 0
                    breakdown.totalProfit += amount

                    if (p.status === "credited") {
                      breakdown.creditedProfit += amount
                    } else if (p.status === "withdrawn") {
                      breakdown.withdrawnProfit += amount
                    }
                  })

                  // Get approved withdrawals to subtract from available balance
                  const { data: approvedWithdrawals, error: withdrawalError } = await supabase
                    .from("withdrawal_requests")
                    .select("amount")
                    .eq("shop_id", paymentData.shop_id)
                    .eq("status", "approved")

                  let totalApprovedWithdrawals = 0
                  if (!withdrawalError && approvedWithdrawals) {
                    totalApprovedWithdrawals = approvedWithdrawals.reduce((sum: number, w: any) => sum + (w.amount || 0), 0)
                  }

                  // Available balance = credited profit - approved withdrawals
                  const availableBalance = Math.max(0, breakdown.creditedProfit - totalApprovedWithdrawals)
                  
                  console.log(`[WEBHOOK-BALANCE] Shop ${paymentData.shop_id}:`, {
                    creditedProfit: breakdown.creditedProfit,
                    totalApprovedWithdrawals,
                    calculation: `${breakdown.creditedProfit} - ${totalApprovedWithdrawals}`,
                    availableBalance,
                  })

                  // Delete existing record and insert fresh (more reliable than upsert)
                  const deleteResult = await supabase
                    .from("shop_available_balance")
                    .delete()
                    .eq("shop_id", paymentData.shop_id)
                  
                  if (deleteResult.error) {
                    console.warn(`[WEBHOOK] Warning deleting old balance:`, deleteResult.error)
                  }

                  const { data, error: insertError } = await supabase
                    .from("shop_available_balance")
                    .insert([
                      {
                        shop_id: paymentData.shop_id,
                        available_balance: availableBalance,
                        total_profit: breakdown.totalProfit,
                        withdrawn_amount: breakdown.withdrawnProfit,
                        credited_profit: breakdown.creditedProfit,
                        withdrawn_profit: breakdown.withdrawnProfit,
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                      }
                    ])

                  if (insertError) {
                    console.error(`[WEBHOOK] Error syncing balance for shop ${paymentData.shop_id}:`, insertError)
                  } else {
                    console.log(`[WEBHOOK] ✓ Available balance synced for shop: ${paymentData.shop_id} - Available: GHS ${availableBalance.toFixed(2)}`)
                  }
                }
              } catch (syncError) {
                console.error("Error syncing available balance:", syncError)
                // Don't throw - profit record was already created
              }
            }
          }

          // Create parent shop profit record if this is a sub-agent sale
          if (shopOrderData?.parent_shop_id && shopOrderData?.parent_profit_amount > 0) {
            console.log(`[WEBHOOK] Sub-agent sale detected. Crediting parent shop ${shopOrderData.parent_shop_id} with GHS ${shopOrderData.parent_profit_amount}`)
            
            // Get current parent balance before adding this profit
            const { data: existingParentProfits } = await supabase
              .from("shop_profits")
              .select("profit_amount, status")
              .eq("shop_id", shopOrderData.parent_shop_id)
            
            const parentBalanceBefore = existingParentProfits?.reduce((sum: number, p: any) => {
              if (p.status === "pending" || p.status === "credited") {
                return sum + (p.profit_amount || 0)
              }
              return sum
            }, 0) || 0
            const parentBalanceAfter = parentBalanceBefore + shopOrderData.parent_profit_amount

            const { error: parentProfitError } = await supabase
              .from("shop_profits")
              .insert([
                {
                  shop_id: shopOrderData.parent_shop_id,
                  shop_order_id: paymentData.order_id,
                  profit_amount: shopOrderData.parent_profit_amount,
                  profit_balance_before: parentBalanceBefore,
                  profit_balance_after: parentBalanceAfter,
                  status: "credited",
                  created_at: new Date().toISOString(),
                }
              ])

            if (parentProfitError) {
              console.error("Error creating parent shop profit record:", parentProfitError)
            } else {
              console.log(`[WEBHOOK] ✓ Parent shop profit record created: GHS ${shopOrderData.parent_profit_amount.toFixed(2)}`)
              
              // Sync parent shop available balance
              try {
                const { data: parentProfits, error: parentProfitFetchError } = await supabase
                  .from("shop_profits")
                  .select("profit_amount, status")
                  .eq("shop_id", shopOrderData.parent_shop_id)

                if (!parentProfitFetchError && parentProfits) {
                  const parentBreakdown = {
                    totalProfit: 0,
                    creditedProfit: 0,
                    withdrawnProfit: 0,
                  }

                  parentProfits.forEach((p: any) => {
                    const amount = p.profit_amount || 0
                    parentBreakdown.totalProfit += amount
                    if (p.status === "credited") {
                      parentBreakdown.creditedProfit += amount
                    } else if (p.status === "withdrawn") {
                      parentBreakdown.withdrawnProfit += amount
                    }
                  })

                  const { data: parentWithdrawals } = await supabase
                    .from("withdrawal_requests")
                    .select("amount")
                    .eq("shop_id", shopOrderData.parent_shop_id)
                    .eq("status", "approved")

                  let totalParentWithdrawals = 0
                  if (parentWithdrawals) {
                    totalParentWithdrawals = parentWithdrawals.reduce((sum: number, w: any) => sum + (w.amount || 0), 0)
                  }

                  const parentAvailableBalance = Math.max(0, parentBreakdown.creditedProfit - totalParentWithdrawals)

                  // Delete and insert fresh balance
                  await supabase
                    .from("shop_available_balance")
                    .delete()
                    .eq("shop_id", shopOrderData.parent_shop_id)

                  const { error: parentBalanceInsertError } = await supabase
                    .from("shop_available_balance")
                    .insert([
                      {
                        shop_id: shopOrderData.parent_shop_id,
                        available_balance: parentAvailableBalance,
                        total_profit: parentBreakdown.totalProfit,
                        withdrawn_amount: parentBreakdown.withdrawnProfit,
                        credited_profit: parentBreakdown.creditedProfit,
                        withdrawn_profit: parentBreakdown.withdrawnProfit,
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                      }
                    ])

                  if (!parentBalanceInsertError) {
                    console.log(`[WEBHOOK] ✓ Parent shop balance synced: ${shopOrderData.parent_shop_id} - Available: GHS ${parentAvailableBalance.toFixed(2)}`)
                  }
                }
              } catch (parentSyncError) {
                console.error("Error syncing parent shop balance:", parentSyncError)
              }
            }
          } else if (shopOrderData?.parent_shop_id) {
            console.log(`[WEBHOOK] ⚠️ Parent shop exists (${shopOrderData.parent_shop_id}) but parent_profit_amount is ${shopOrderData.parent_profit_amount} - skipping parent profit record`)
          }
        }
      }

      // Credit the wallet ONLY if this is a wallet top-up (not a shop order payment)
      // Shop orders go to shop profits, not user wallet
      const isShopOrderPayment = paymentData.order_id && paymentData.shop_id
      console.log("[WEBHOOK] Payment type check:", {
        isShopOrder: isShopOrderPayment,
        hasOrderId: !!paymentData.order_id,
        hasShopId: !!paymentData.shop_id,
      })
      
      if (!isShopOrderPayment) {
        console.log("[WEBHOOK] This is a WALLET payment - will credit wallet and send SMS")
        const amountInGHS = amount / 100
        
        // Calculate the actual credit amount (excluding the 3% fee)
        // Fee is stored in the payment record
        const feeAmount = paymentData.fee || 0
        const creditAmount = amountInGHS - feeAmount

        console.log(`[WEBHOOK] Credit calculation:`)
        console.log(`  Total paid: GHS ${amountInGHS.toFixed(2)}`)
        console.log(`  Fee (3%): GHS ${feeAmount.toFixed(2)}`)
        console.log(`  Credit amount: GHS ${creditAmount.toFixed(2)}`)

        // Get current wallet balance
        const { data: walletData, error: walletFetchError } = await supabase
          .from("wallets")
          .select("balance, total_credited")
          .eq("user_id", paymentData.user_id)
          .single()

        if (walletFetchError && walletFetchError.code !== "PGRST116") {
          console.error("[WEBHOOK] Error fetching wallet:", walletFetchError)
          throw walletFetchError
        }

        const currentBalance = walletData?.balance || 0
        const currentTotalCredited = walletData?.total_credited || 0
        
        // Check if this reference was already used to credit the wallet (idempotency check)
        const { data: existingTransaction } = await supabase
          .from("transactions")
          .select("id")
          .eq("reference_id", reference)
          .eq("user_id", paymentData.user_id)
          .eq("type", "credit")
          .maybeSingle()

        if (existingTransaction) {
          console.log(`[WEBHOOK] ✓ Reference ${reference} already credited. Skipping duplicate credit.`)
          return NextResponse.json({ received: true, skipped: "already_credited" })
        }

        const newBalance = currentBalance + creditAmount
        const newTotalCredited = currentTotalCredited + creditAmount

        // Update wallet balance
        const { error: walletUpdateError } = await supabase
          .from("wallets")
          .upsert(
            {
              user_id: paymentData.user_id,
              balance: newBalance,
              total_credited: newTotalCredited,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "user_id" }
          )

        if (walletUpdateError) {
          console.error("[WEBHOOK] Error updating wallet:", walletUpdateError)
          throw walletUpdateError
        }

        // Create transaction record
        const { error: transactionError } = await supabase
          .from("transactions")
          .insert([
            {
              user_id: paymentData.user_id,
              type: "credit",
              amount: creditAmount,
              reference_id: reference,
              source: "wallet_topup",
              description: "Wallet top-up via Paystack",
              status: "completed",
              balance_before: currentBalance,
              balance_after: newBalance,
              created_at: new Date().toISOString(),
            },
          ])

        if (transactionError) {
          // Check if error is duplicate key (transaction already exists)
          if (transactionError.code === "23505") {
            console.warn(`[WEBHOOK] Transaction record already exists for reference ${reference}. Skipping duplicate.`)
          } else {
            console.error("[WEBHOOK] Error creating transaction record:", transactionError)
            // Don't throw - transaction was already applied to wallet
          }
        }

        console.log(`[WEBHOOK] ✓ Wallet credited for user ${paymentData.user_id}: GHS ${creditAmount.toFixed(2)} (after GHS ${feeAmount.toFixed(2)} fee)`)
        
        // Send notification to user about wallet top-up
        try {
          const notificationData = notificationTemplates.balanceUpdated(newBalance)
          const { error: notifError } = await supabase
            .from("notifications")
            .insert([
              {
                user_id: paymentData.user_id,
                title: notificationData.title,
                message: `${notificationData.message} Credited amount: GHS ${creditAmount.toFixed(2)}.`,
                type: notificationData.type,
                reference_id: `PAYSTACK_${paymentData.reference}`,
                action_url: "/dashboard/wallet",
                read: false,
              },
            ])
          if (notifError) {
            console.warn("[NOTIFICATION] Failed to send wallet top-up notification:", notifError)
          } else {
            console.log(`[NOTIFICATION] Wallet top-up notification sent to user ${paymentData.user_id}`)
          }
        } catch (notifError) {
          console.warn("[NOTIFICATION] Failed to send wallet top-up notification:", notifError)
          // Don't fail the webhook if notification fails
        }

        // Send SMS to user about wallet top-up
        try {
          // Get user's phone number and first name from users table
          const { data: userData, error: userError } = await supabase
            .from("users")
            .select("phone_number, first_name")
            .eq("id", paymentData.user_id)
            .single()
          
          if (!userError && userData?.phone_number) {
            const firstName = userData.first_name || 'User'
            const smsMessage = `Hi ${firstName}, your wallet has been topped up by GHS ${creditAmount.toFixed(2)}. New balance: GHS ${newBalance.toFixed(2)}`
            
            await sendSMS({
              phone: userData.phone_number,
              message: smsMessage,
              type: 'wallet_topup_success',
              reference: paymentData.id,
            }).catch(err => console.error("[WEBHOOK] SMS error:", err))
            
            console.log(`[SMS] Wallet top-up SMS sent to user ${paymentData.user_id}`)
          } else if (userError) {
            console.warn("[SMS] Failed to fetch user phone number:", userError)
          } else {
            console.warn("[SMS] User does not have a phone number on file")
          }
        } catch (smsError) {
          console.warn("[SMS] Failed to send wallet top-up SMS:", smsError)
          // Don't fail the webhook if SMS fails
        }
      } else {
        console.log(`[WEBHOOK] ✓ Shop order payment - NOT credited to wallet (profit goes to shop instead)`)
      }

      console.log(`[WEBHOOK] ✓ Payment processed successfully: ${reference}`)
    } else if (event.event === "charge.failed") {
      // Handle failed payment
      const { reference, customer, amount, gateway_response } = event.data
      const amountInGHS = amount / 100

      console.log(`[WEBHOOK] Processing failed payment: ${reference}`, {
        email: customer?.email,
        amount: amountInGHS,
        reason: gateway_response,
      })

      // Find payment record
      const { data: paymentData, error: fetchError } = await supabase
        .from("wallet_payments")
        .select("id, user_id, status, shop_id, order_id, reference")
        .eq("reference", reference)
        .single()

      if (fetchError || !paymentData) {
        console.warn(`[WEBHOOK] Failed payment record not found for reference: ${reference}`)
        return NextResponse.json({ received: true, warning: "payment_record_not_found" })
      }

      // Update payment status to failed
      const { error: updateError } = await supabase
        .from("wallet_payments")
        .update({
          status: "failed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", paymentData.id)

      if (updateError) {
        console.error("[WEBHOOK] Error updating payment to failed:", updateError)
      }

      // Update payment_attempts to failed (non-blocking)
      supabase
        .from("payment_attempts")
        .update({
          status: "failed",
          gateway_response: gateway_response || "Payment declined",
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("reference", reference)
        .then(({ error }) => {
          if (error) console.warn("[WEBHOOK] Failed to update payment_attempts to failed:", error.message)
          else console.log("[WEBHOOK] ✓ payment_attempts updated to failed")
        })

      // Create failed transaction record for tracking (only for wallet top-ups, not shop orders)
      if (!paymentData.shop_id) {
        const { error: transactionError } = await supabase
          .from("transactions")
          .insert([
            {
              user_id: paymentData.user_id,
              type: "credit",
              amount: amountInGHS,
              reference_id: reference,
              source: "wallet_topup",
              description: `Failed wallet top-up: ${gateway_response || "Payment declined"}`,
              status: "failed",
              created_at: new Date().toISOString(),
            },
          ])

        if (transactionError) {
          // Check for duplicate
          if (transactionError.code === "23505") {
            console.warn(`[WEBHOOK] Failed transaction record already exists for ${reference}`)
          } else {
            console.error("[WEBHOOK] Error creating failed transaction record:", transactionError)
          }
        } else {
          console.log(`[WEBHOOK] ✓ Failed transaction record created for ${reference}`)
        }

        // Send notification to user about failed payment
        try {
          const { error: notifError } = await supabase
            .from("notifications")
            .insert([
              {
                user_id: paymentData.user_id,
                title: "Payment Failed",
                message: `Your wallet top-up of GHS ${amountInGHS.toFixed(2)} failed. Reason: ${gateway_response || "Payment declined"}. Please try again.`,
                type: "payment_failed",
                is_read: false,
                created_at: new Date().toISOString(),
              },
            ])

          if (notifError) {
            console.warn("[WEBHOOK] Failed to create failure notification:", notifError)
          }
        } catch (notifError) {
          console.warn("[WEBHOOK] Error creating failure notification:", notifError)
        }

        // Send SMS for failed payment
        try {
          const { data: userData } = await supabase
            .from("users")
            .select("phone_number, first_name")
            .eq("id", paymentData.user_id)
            .single()

          if (userData?.phone_number) {
            const firstName = userData.first_name || "Customer"
            const smsMessage = `Hi ${firstName}, your wallet top-up of GHS ${amountInGHS.toFixed(2)} failed. ${gateway_response || "Please try again."}`
            
            await sendSMS({
              phone: userData.phone_number,
              message: smsMessage,
              type: 'wallet_topup_failed',
              reference: paymentData.id,
            }).catch(err => console.error("[WEBHOOK] Failed payment SMS error:", err))
            
            console.log(`[SMS] Failed payment SMS sent to user ${paymentData.user_id}`)
          }
        } catch (smsError) {
          console.warn("[SMS] Failed to send payment failure SMS:", smsError)
        }
      } else {
        // Update shop order payment status to failed
        if (paymentData.order_id) {
          const { error: orderUpdateError } = await supabase
            .from("shop_orders")
            .update({
              payment_status: "failed",
              updated_at: new Date().toISOString(),
            })
            .eq("id", paymentData.order_id)

          if (orderUpdateError) {
            console.error("[WEBHOOK] Error updating shop order to failed:", orderUpdateError)
          } else {
            console.log(`[WEBHOOK] ✓ Shop order ${paymentData.order_id} marked as payment failed`)
          }
        }
      }

      console.log(`[WEBHOOK] ✓ Failed payment processed: ${reference}`)
    } else {
      console.log(`[WEBHOOK] ⚠️ Event type not handled: ${event.event}`)
    }

    // Acknowledge receipt of webhook
    console.log("[WEBHOOK] ========== WEBHOOK COMPLETE ==========")
    return NextResponse.json({ received: true })
  } catch (error) {
    console.error("[WEBHOOK] ✗ Error:", error)
    console.log("[WEBHOOK] ========== WEBHOOK FAILED ==========")
    return NextResponse.json(
      { error: "Payment processing failed. Please contact support." },
      { status: 500 }
    )
  }
}
