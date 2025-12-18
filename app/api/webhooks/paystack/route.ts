import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import crypto from "crypto"
import { notificationTemplates } from "@/lib/notification-service"
import { sendSMS } from "@/lib/sms-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

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
        
        // Get shop order details to create profit record
        const { data: shopOrderData, error: orderFetchError } = await supabase
          .from("shop_orders")
          .select("id, shop_id, profit_amount, customer_phone, customer_email, network, volume_gb, total_price, reference_code")
          .eq("id", paymentData.order_id)
          .single()

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
            
            // Send SMS to customer about payment confirmation
            if (shopOrderData?.customer_phone) {
              try {
                // Get shop name and owner's phone number for support contact
                const { data: shopData, error: shopFetchError } = await supabase
                  .from("user_shops")
                  .select("shop_name, phone_number")
                  .eq("id", paymentData.shop_id)
                  .single()
                
                const shopName = shopData?.shop_name || "Shop"
                const shopOwnerPhone = shopData?.phone_number || "Support"
                
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

          // Create shop profit record
          if (shopOrderData?.profit_amount > 0) {
            const { error: profitError } = await supabase
              .from("shop_profits")
              .insert([
                {
                  shop_id: paymentData.shop_id,
                  shop_order_id: paymentData.order_id,
                  profit_amount: shopOrderData.profit_amount,
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
                    totalApprovedWithdrawals = approvedWithdrawals.reduce((sum, w) => sum + (w.amount || 0), 0)
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
      { error: error instanceof Error ? error.message : "Webhook processing failed" },
      { status: 500 }
    )
  }
}
