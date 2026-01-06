import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { sendSMS } from "@/lib/sms-service"
import { atishareService } from "@/lib/at-ishare-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

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
      return true
    }
    
    return data.value?.enabled ?? true
  } catch (error) {
    console.warn("[WALLET-DEBIT] Error checking auto-fulfillment setting:", error)
    return true
  }
}

export async function POST(request: NextRequest) {
  try {
    // Get user from auth header
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      console.error("[WALLET-DEBIT] Auth error:", authError)
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    const { amount, orderId, description } = await request.json()

    console.log("[WALLET-DEBIT] Request received:")
    console.log("  User:", user.id)
    console.log("  Amount:", amount)
    console.log("  Order ID:", orderId)
    console.log("  Description:", description)

    if (!amount || amount <= 0) {
      return NextResponse.json(
        { error: "Invalid amount" },
        { status: 400 }
      )
    }

    // Get wallet (select only needed columns)
    console.log("[WALLET-DEBIT] Fetching wallet...")
    const { data: wallet, error: walletError } = await supabase
      .from("wallets")
      .select("balance, total_spent")
      .eq("user_id", user.id)
      .maybeSingle()

    if (walletError) {
      console.error("[WALLET-DEBIT] Wallet fetch error:", walletError)
      return NextResponse.json(
        { error: "Failed to fetch wallet" },
        { status: 400 }
      )
    }

    if (!wallet) {
      return NextResponse.json(
        { error: "Wallet not found" },
        { status: 404 }
      )
    }

    const currentBalance = wallet.balance || 0
    console.log("[WALLET-DEBIT] Current balance:", currentBalance)

    if (currentBalance < amount) {
      console.warn("[WALLET-DEBIT] Insufficient balance")
      return NextResponse.json(
        {
          error: "Insufficient balance",
          currentBalance,
          required: amount,
        },
        { status: 400 }
      )
    }

    // Deduct from wallet
    console.log("[WALLET-DEBIT] Deducting amount...")
    const newBalance = currentBalance - amount
    const newTotalSpent = (wallet.total_spent || 0) + amount

    const { error: updateError } = await supabase
      .from("wallets")
      .update({
        balance: newBalance,
        total_spent: newTotalSpent,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", user.id)

    if (updateError) {
      console.error("[WALLET-DEBIT] Update error:", updateError)
      return NextResponse.json(
        { error: "Failed to update wallet" },
        { status: 400 }
      )
    }

    // Create debit transaction
    console.log("[WALLET-DEBIT] Creating transaction...")
    const { error: txError } = await supabase
      .from("transactions")
      .insert([{
        user_id: user.id,
        type: "debit",
        amount,
        reference_id: orderId,
        description: description || "Order payment",
        source: "wallet_debit",
        status: "completed",
        balance_before: currentBalance,
        balance_after: newBalance,
        created_at: new Date().toISOString(),
      }])

    if (txError) {
      console.error("[WALLET-DEBIT] Transaction error:", txError)
      return NextResponse.json(
        { error: "Failed to create transaction" },
        { status: 400 }
      )
    }

    // If this is a shop order payment via wallet, mark it as paid and handle profits
    if (orderId) {
      console.log("[WALLET-DEBIT] Checking if order is a shop order...")
      const { data: shopOrder, error: shopOrderError } = await supabase
        .from("shop_orders")
        .select("id, shop_id, profit_amount, parent_shop_id, parent_profit_amount, network, volume_gb, customer_phone")
        .eq("id", orderId)
        .maybeSingle()

      if (!shopOrderError && shopOrder) {
        console.log("[WALLET-DEBIT] Marking shop order payment as completed...")
        const { error: updateShopOrderError } = await supabase
          .from("shop_orders")
          .update({
            payment_status: "completed",
            order_status: "pending", // Keep as pending for admin to process
            updated_at: new Date().toISOString(),
          })
          .eq("id", orderId)

        if (updateShopOrderError) {
          console.error("[WALLET-DEBIT] Failed to update shop order:", updateShopOrderError)
        } else {
          console.log("[WALLET-DEBIT] ✓ Shop order payment status updated to completed")
          
          // Send SMS notification about successful purchase
          if (shopOrder.customer_phone) {
            try {
              const smsMessage = `You have successfully placed an order of ${shopOrder.network} ${shopOrder.volume_gb}GB to ${shopOrder.customer_phone}. If delayed over 2 hours, contact support.`
              
              await sendSMS({
                phone: shopOrder.customer_phone,
                message: smsMessage,
                type: 'data_purchase_success',
                reference: orderId,
              }).catch(err => console.error("[WALLET-DEBIT] SMS error:", err))
              
              console.log("[WALLET-DEBIT] ✓ SMS notification sent")
            } catch (smsError) {
              console.warn("[WALLET-DEBIT] Failed to send purchase SMS:", smsError)
            }
          }

          // Trigger auto-fulfillment for supported networks
          const fulfillableNetworks = ["AT - iShare", "AT-iShare", "AT - ishare", "at - ishare", "Telecel", "telecel", "TELECEL", "AT - BigTime", "AT-BigTime", "AT - bigtime", "at - bigtime"]
          const normalizedNetwork = shopOrder.network?.trim() || ""
          const isAutoFulfillable = fulfillableNetworks.some(n => n.toLowerCase() === normalizedNetwork.toLowerCase())
          
          const autoFulfillEnabled = await isAutoFulfillmentEnabled()
          const shouldFulfill = isAutoFulfillable && autoFulfillEnabled && shopOrder.customer_phone
          
          console.log(`[WALLET-DEBIT] Network: "${shopOrder.network}" | Auto-fulfillable: ${isAutoFulfillable} | Enabled: ${autoFulfillEnabled} | Should fulfill: ${shouldFulfill}`)
          
          if (shouldFulfill) {
            try {
              const sizeGb = parseInt(shopOrder.volume_gb?.toString().replace(/[^0-9]/g, "") || "0") || 0
              const networkLower = normalizedNetwork.toLowerCase()
              const isBigTime = networkLower.includes("bigtime")
              const apiNetwork = networkLower.includes("telecel") ? "TELECEL" : "AT"
              
              console.log(`[WALLET-DEBIT] Triggering fulfillment: ${apiNetwork}, ${sizeGb}GB to ${shopOrder.customer_phone}`)
              
              atishareService.fulfillOrder({
                phoneNumber: shopOrder.customer_phone,
                sizeGb,
                orderId: orderId,
                network: apiNetwork,
                orderType: "shop",
                isBigTime,
              }).then(result => {
                console.log(`[WALLET-DEBIT] ✓ Fulfillment response:`, result)
              }).catch(err => {
                console.error(`[WALLET-DEBIT] ❌ Fulfillment error:`, err)
              })
            } catch (fulfillmentError) {
              console.error("[WALLET-DEBIT] Error in fulfillment trigger:", fulfillmentError)
            }
          }

          // Handle MTN fulfillment separately via unified fulfillment endpoint
          const isMTNNetwork = normalizedNetwork.toLowerCase() === "mtn"
          if (isMTNNetwork && shopOrder.customer_phone) {
            console.log(`[WALLET-DEBIT] MTN order detected. Triggering unified fulfillment for order ${orderId}`)
            const sizeGb = parseInt(shopOrder.volume_gb?.toString().replace(/[^0-9]/g, "") || "0") || 0
            
            // Non-blocking MTN fulfillment trigger via unified endpoint
            fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'https://www.datagod.store'}/api/fulfillment/process-order`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                shop_order_id: orderId,
                network: "MTN",
                phone_number: shopOrder.customer_phone,
                volume_gb: sizeGb,
                customer_name: shopOrder.customer_phone,
              }),
            }).then(async (res) => {
              const result = await res.json()
              console.log(`[WALLET-DEBIT] ✓ MTN fulfillment triggered for order ${orderId}:`, result)
            }).catch(err => {
              console.error(`[WALLET-DEBIT] ❌ Error triggering MTN fulfillment for order ${orderId}:`, err)
            })
          }
        }

        // Create parent shop profit record if this is a sub-agent order
        if (shopOrder.parent_shop_id && shopOrder.parent_profit_amount > 0) {
          console.log(`[WALLET-DEBIT] Sub-agent purchase detected. Crediting parent shop ${shopOrder.parent_shop_id} with GHS ${shopOrder.parent_profit_amount}`)
          
          const { error: parentProfitError } = await supabase
            .from("shop_profits")
            .insert([
              {
                shop_id: shopOrder.parent_shop_id,
                shop_order_id: orderId,
                profit_amount: shopOrder.parent_profit_amount,
                status: "credited",
                created_at: new Date().toISOString(),
              }
            ])

          if (parentProfitError) {
            console.error("[WALLET-DEBIT] Error creating parent shop profit record:", parentProfitError)
          } else {
            console.log(`[WALLET-DEBIT] ✓ Parent shop profit record created: GHS ${shopOrder.parent_profit_amount.toFixed(2)}`)
            
            // Sync parent shop available balance
            try {
              const { data: parentProfits, error: parentProfitFetchError } = await supabase
                .from("shop_profits")
                .select("profit_amount, status")
                .eq("shop_id", shopOrder.parent_shop_id)

              if (!parentProfitFetchError && parentProfits) {
                const parentBreakdown = {
                  totalProfit: 0,
                  creditedProfit: 0,
                  withdrawnProfit: 0,
                }

                parentProfits.forEach((p: any) => {
                  const amt = p.profit_amount || 0
                  parentBreakdown.totalProfit += amt
                  if (p.status === "credited") {
                    parentBreakdown.creditedProfit += amt
                  } else if (p.status === "withdrawn") {
                    parentBreakdown.withdrawnProfit += amt
                  }
                })

                const { data: parentWithdrawals } = await supabase
                  .from("withdrawal_requests")
                  .select("amount")
                  .eq("shop_id", shopOrder.parent_shop_id)
                  .eq("status", "approved")

                let totalParentWithdrawals = 0
                if (parentWithdrawals) {
                  totalParentWithdrawals = parentWithdrawals.reduce((sum: number, w: any) => sum + (w.amount || 0), 0)
                }

                const parentAvailableBalance = Math.max(0, parentBreakdown.creditedProfit - totalParentWithdrawals)

                console.log(`[WALLET-DEBIT] Parent shop ${shopOrder.parent_shop_id} balance:`, {
                  creditedProfit: parentBreakdown.creditedProfit,
                  totalWithdrawals: totalParentWithdrawals,
                  availableBalance: parentAvailableBalance,
                })

                // Delete and insert fresh balance record
                await supabase
                  .from("shop_available_balance")
                  .delete()
                  .eq("shop_id", shopOrder.parent_shop_id)

                const { error: parentBalanceInsertError } = await supabase
                  .from("shop_available_balance")
                  .insert([
                    {
                      shop_id: shopOrder.parent_shop_id,
                      available_balance: parentAvailableBalance,
                      total_profit: parentBreakdown.totalProfit,
                      withdrawn_amount: parentBreakdown.withdrawnProfit,
                      credited_profit: parentBreakdown.creditedProfit,
                      withdrawn_profit: parentBreakdown.withdrawnProfit,
                      created_at: new Date().toISOString(),
                      updated_at: new Date().toISOString(),
                    }
                  ])

                if (parentBalanceInsertError) {
                  console.error(`[WALLET-DEBIT] Error syncing parent shop balance:`, parentBalanceInsertError)
                } else {
                  console.log(`[WALLET-DEBIT] ✓ Parent shop available balance synced: GHS ${parentAvailableBalance.toFixed(2)}`)
                }
              }
            } catch (syncError) {
              console.error("[WALLET-DEBIT] Error syncing parent shop balance:", syncError)
              // Don't fail - profit record was already created
            }
          }
        }
      }
    }

    console.log("[WALLET-DEBIT] ✓ Success - New balance:", newBalance)

    return NextResponse.json({
      success: true,
      newBalance,
      amount,
      reference: orderId,
    })
  } catch (error) {
    console.error("[WALLET-DEBIT] ✗ Error:", error)
    return NextResponse.json(
      { error: "Failed to process payment. Please try again." },
      { status: 500 }
    )
  }
}
