import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import crypto from "crypto"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * Webhook endpoint for Paystack payment notifications
 * Configure this URL in your Paystack dashboard settings
 */
export async function POST(request: NextRequest) {
  try {
    // Verify request is from Paystack
    const signature = request.headers.get("x-paystack-signature")

    if (!signature) {
      return NextResponse.json(
        { error: "Invalid request: missing signature" },
        { status: 401 }
      )
    }

    const body = await request.text()
    const hash = crypto.createHmac("sha512", paystackSecretKey).update(body).digest("hex")

    if (hash !== signature) {
      return NextResponse.json(
        { error: "Invalid signature" },
        { status: 401 }
      )
    }

    const event = JSON.parse(body)

    // Handle charge.success event
    if (event.event === "charge.success") {
      const { reference, customer, amount, status } = event.data

      console.log(`Processing payment: ${reference}`, {
        email: customer.email,
        amount: amount / 100,
        status,
      })

      // Find and update payment record
      const { data: paymentData, error: fetchError } = await supabase
        .from("wallet_payments")
        .select("*")
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

      // If this is a shop order payment, update shop_orders payment status and create profit record
      if (paymentData.order_id && paymentData.shop_id) {
        console.log(`[WEBHOOK] Updating shop order payment status for order: ${paymentData.order_id}`)
        
        // Get shop order details to create profit record
        const { data: shopOrderData, error: orderFetchError } = await supabase
          .from("shop_orders")
          .select("id, shop_id, profit_amount")
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
      
      if (!isShopOrderPayment) {
        const amountInGHS = amount / 100

        // Get current wallet balance
        const { data: walletData, error: walletFetchError } = await supabase
          .from("user_wallets")
          .select("balance")
          .eq("user_id", paymentData.user_id)
          .single()

        if (walletFetchError && walletFetchError.code !== "PGRST116") {
          console.error("Error fetching wallet:", walletFetchError)
          throw walletFetchError
        }

        const currentBalance = walletData?.balance || 0
        const newBalance = currentBalance + amountInGHS

        // Update wallet balance
        const { error: walletUpdateError } = await supabase
          .from("user_wallets")
          .upsert(
            {
              user_id: paymentData.user_id,
              balance: newBalance,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "user_id" }
          )

        if (walletUpdateError) {
          console.error("Error updating wallet:", walletUpdateError)
          throw walletUpdateError
        }

        // Create transaction record
        const { error: transactionError } = await supabase
          .from("wallet_transactions")
          .insert([
            {
              user_id: paymentData.user_id,
              type: "credit",
              amount: amountInGHS,
              reference: reference,
              description: "Wallet top-up via Paystack",
              status: "completed",
              created_at: new Date().toISOString(),
            },
          ])

        if (transactionError) {
          console.error("Error creating transaction record:", transactionError)
          // Don't throw - transaction was already applied to wallet
        }

        console.log(`[WEBHOOK] ✓ Wallet credited for user ${paymentData.user_id}: GHS ${amountInGHS.toFixed(2)}`)
      } else {
        console.log(`[WEBHOOK] ✓ Shop order payment - NOT credited to wallet (profit goes to shop instead)`)
      }

      console.log(`Payment processed successfully: ${reference}`)
    }

    // Acknowledge receipt of webhook
    return NextResponse.json({ received: true })
  } catch (error) {
    console.error("Webhook error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Webhook processing failed" },
      { status: 500 }
    )
  }
}
