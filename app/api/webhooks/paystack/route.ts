import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import crypto from "crypto"
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
    if (!signature) {
      console.warn("[WEBHOOK] Missing signature")
      return NextResponse.json(
        { error: "Invalid request: missing signature" },
        { status: 401 }
      )
    }

    const body = await request.text()
    const hash = crypto.createHmac("sha512", paystackSecretKey).update(body).digest("hex")

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
      let { reference, amount, status, metadata } = event.data

      // Paystack metadata can sometimes be sent as a string
      if (typeof metadata === "string" && metadata.length > 0) {
        try {
          metadata = JSON.parse(metadata)
          console.log("[WEBHOOK] Parsed metadata string into object")
        } catch (e) {
          console.warn("[WEBHOOK] Failed to parse metadata string:", e)
        }
      }

      console.log(`Processing payment: ${reference}`, {
        amount: amount / 100,
        status,
        hasMetadata: !!metadata
      })

      // Find and update payment record
      const { data: paymentData, error: fetchError } = await supabase
        .from("wallet_payments")
        .select("id, user_id, status, shop_id, order_id, order_type, fee, reference, amount")
        .eq("reference", reference)
        .single()

      if (fetchError || !paymentData) {
        console.error("Payment record not found:", fetchError)
        return NextResponse.json(
          { error: "Payment record not found" },
          { status: 404 }
        )
      }

      const isDealerUpgrade = (metadata?.type === "dealer_upgrade") || (paymentData.order_type === "dealer_upgrade")
      const isAirtime = (paymentData.order_type === "airtime") || (metadata?.orderType === "airtime")
      // CRITICAL SECURITY CHECK: Re-verify price
      const paidAmountPesewas = Math.round(amount)
      let expectedAmountGHS = Number(paymentData.amount)
      const feeAmount = Number(paymentData.fee || 0)

      if (paymentData.order_id) {
        let verifiedTotalPrice = 0

        if (isDealerUpgrade) {
          const { data: plan } = await supabase
            .from("subscription_plans")
            .select("price")
            .eq("id", paymentData.order_id)
            .single()

          if (plan) {
            verifiedTotalPrice = Number(plan.price)
          }
        } else if (isAirtime) {
          const { data: airtimeOrder } = await supabase
            .from("airtime_orders")
            .select("total_paid")
            .eq("id", paymentData.order_id)
            .single()

          if (airtimeOrder) {
            verifiedTotalPrice = Number(airtimeOrder.total_paid)
          }
        } else {
          const { data: shopOrder } = await supabase
            .from("shop_orders")
            .select("total_price")
            .eq("id", paymentData.order_id)
            .single()

          if (shopOrder) {
            verifiedTotalPrice = Number(shopOrder.total_price)
          }
        }

        if (verifiedTotalPrice > 0) {
          expectedAmountGHS = verifiedTotalPrice + feeAmount
        }
      }

      const expectedAmountPesewas = Math.round((expectedAmountGHS + Number.EPSILON) * 100)

      if (paidAmountPesewas < expectedAmountPesewas) {
        console.error(`[WEBHOOK] ❌ UNDERPAYMENT! Paid: ${paidAmountPesewas / 100}, Expected: ${expectedAmountPesewas / 100}`)
        return NextResponse.json({ error: "Underpayment" }, { status: 400 })
      }

      // Update payment status
      await supabase
        .from("wallet_payments")
        .update({
          status: "completed",
          amount_received: amount / 100,
          paystack_transaction_id: event.data.id,
          updated_at: new Date().toISOString(),
        })
        .eq("id", paymentData.id)

      // Update payment_attempts
      try {
        await supabase
          .from("payment_attempts")
          .update({
            status: "completed",
            paystack_transaction_id: event.data.id,
            gateway_response: event.data.gateway_response || "success",
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("reference", reference)
      } catch (err) {
        console.warn("[WEBHOOK] Failed to update payment_attempts:", err)
      }

      // 1. Handle Shop Orders and Airtime
      if (paymentData.order_id && !isDealerUpgrade) {
        if (!isAirtime) {
          // Shop Order fulfillment logic
          const { data: shopOrderData } = await supabase
            .from("shop_orders")
            .select("*")
            .eq("id", paymentData.order_id)
            .single()

          if (shopOrderData) {
            await supabase
              .from("shop_orders")
              .update({ payment_status: "completed", transaction_id: event.data.id, updated_at: new Date().toISOString() })
              .eq("id", paymentData.order_id)

            // Auto-fulfillment trigger via unified endpoint
            try {
              const baseUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000")
              const digits = shopOrderData.volume_gb?.toString().replace(/[^0-9]/g, "") || "0"
              const sizeGb = parseInt(digits) || 0

              console.log(`[WEBHOOK] Triggering unified fulfillment for shop order ${paymentData.order_id}`)
              
              const fulfillmentResponse = await fetch(`${baseUrl}/api/fulfillment/process-order`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  shop_order_id: paymentData.order_id,
                  network: shopOrderData.network,
                  phone_number: shopOrderData.customer_phone,
                  volume_gb: sizeGb,
                  customer_name: shopOrderData.customer_name,
                }),
              })
              
              const fulfillmentResult = await fulfillmentResponse.json()
              if (!fulfillmentResponse.ok) {
                console.error("[WEBHOOK] Unified fulfillment error:", fulfillmentResult)
              } else {
                console.log("[WEBHOOK] ✓ Unified fulfillment triggered successfully")
              }
            } catch (fError) {
              console.error("[WEBHOOK] Failed to trigger unified fulfillment:", fError)
            }

            // Sub-agent profit record — balance is auto-synced by DB trigger
            if (shopOrderData.profit_amount > 0) {
              const { error: profitInsertError } = await supabase.from("shop_profits").insert([{
                shop_id: paymentData.shop_id,
                shop_order_id: paymentData.order_id,
                profit_amount: shopOrderData.profit_amount,
                status: "credited",
                created_at: new Date().toISOString(),
              }])
              if (profitInsertError && profitInsertError.code !== "23505") {
                console.error("[WEBHOOK] Failed to insert shop profit record:", profitInsertError)
              } else {
                console.log(`[WEBHOOK] ✓ Sub-agent profit recorded: GHS ${shopOrderData.profit_amount}`)
              }
            }

            // Parent shop profit record (sub-agent order) — balance is auto-synced by DB trigger
            if (shopOrderData.parent_shop_id && shopOrderData.parent_profit_amount > 0) {
              const { error: parentProfitError } = await supabase.from("shop_profits").insert([{
                shop_id: shopOrderData.parent_shop_id,
                shop_order_id: paymentData.order_id,
                profit_amount: shopOrderData.parent_profit_amount,
                status: "credited",
                created_at: new Date().toISOString(),
              }])
              if (parentProfitError && parentProfitError.code !== "23505") {
                console.error("[WEBHOOK] Failed to insert parent shop profit record:", parentProfitError)
              } else {
                console.log(`[WEBHOOK] ✓ Parent shop profit recorded: GHS ${shopOrderData.parent_profit_amount} for shop ${shopOrderData.parent_shop_id}`)
              }
            }
          }
        } else {
          // Airtime logic
          const { data: airtimeData } = await supabase
            .from("airtime_orders")
            .select("*")
            .eq("id", paymentData.order_id)
            .single()

          if (airtimeData) {
            await supabase
              .from("airtime_orders")
              .update({ payment_status: "completed", status: "pending", transaction_id: event.data.id, updated_at: new Date().toISOString() })
              .eq("id", airtimeData.id)

            if (airtimeData.merchant_commission > 0 && airtimeData.shop_id) {
              const { error: airtimeProfitInsertError } = await supabase.from("shop_profits").insert([{
                shop_id: airtimeData.shop_id,
                airtime_order_id: airtimeData.id,
                profit_amount: airtimeData.merchant_commission,
                status: "credited",
                created_at: new Date().toISOString(),
              }])
              if (airtimeProfitInsertError && airtimeProfitInsertError.code !== "23505") {
                console.error("[WEBHOOK] Failed to insert airtime profit record:", airtimeProfitInsertError)
              } else {
                console.log(`[WEBHOOK] ✓ Airtime profit recorded: GHS ${airtimeData.merchant_commission} (balance synced by DB trigger)`)
              }
            }
          }
        }
      }

      // 2. Handle Dealer Upgrade
      if (isDealerUpgrade) {
        console.log("[WEBHOOK] Processing DEALER UPGRADE...")
        const upgradeUserId = metadata?.userId || paymentData.user_id
        const planId = metadata?.planId || paymentData.order_id

        if (upgradeUserId && planId) {
          const { data: plan } = await supabase.from("subscription_plans").select("*").eq("id", planId).single()
          if (plan) {
            // Update User Role
            await supabase.from("users").update({ role: "dealer", updated_at: new Date().toISOString() }).eq("id", upgradeUserId)
            await supabase.auth.admin.updateUserById(upgradeUserId, { user_metadata: { role: "dealer" } }).catch(() => {})

            // Handle Subscription Record (Idempotent)
            const { data: existingSub } = await supabase.from("user_subscriptions").select("id").eq("payment_reference", reference).maybeSingle()
            if (!existingSub) {
              const endDate = new Date()
              endDate.setDate(endDate.getDate() + plan.duration_days)
              
              await supabase.from("user_subscriptions").insert([{
                user_id: upgradeUserId,
                plan_id: planId,
                start_date: new Date().toISOString(),
                end_date: endDate.toISOString(),
                status: "active",
                payment_reference: reference,
                amount_paid: amount / 100,
              }])

              // Notify User
              await supabase.from("notifications").insert([{
                user_id: upgradeUserId,
                title: "Account Upgraded!",
                message: `Congratulations! Your account has been upgraded to Dealer.`,
                type: "role_change",
              }])

              // SMS
              const { data: userData } = await supabase.from("users").select("phone_number").eq("id", upgradeUserId).single()
              if (userData?.phone_number) {
                 await sendSMS({
                   phone: userData.phone_number,
                   message: `Congratulations! Your account has been upgraded to Dealer. Enjoy wholesale prices!`,
                   type: 'subscription_success',
                   reference: reference,
                 }).catch(() => {})
              }
            }
          }
        }
      }

      // 3. Handle Wallet Top-up (if not an order or dealer upgrade)
      if (!paymentData.order_id && !isDealerUpgrade) {
        const creditAmount = (amount / 100) - (paymentData.fee || 0)
        const { data: rpcData, error: rpcError } = await supabase.rpc("credit_wallet_safely", {
          p_user_id: paymentData.user_id,
          p_amount: creditAmount,
          p_reference_id: reference,
          p_description: "Wallet top-up via Paystack",
          p_source: "wallet_topup"
        })

        if (!rpcError && rpcData?.[0]) {
          const { new_balance: newBalance, already_processed: alreadyProcessed } = rpcData[0]
          if (!alreadyProcessed) {
            // Notifications and SMS handled here...
            const { data: userData } = await supabase.from("users").select("phone_number, first_name").eq("id", paymentData.user_id).single()
            if (userData?.phone_number) {
              await sendSMS({
                phone: userData.phone_number,
                message: `Hi ${userData.first_name || 'User'}, your wallet has been topped up by GHS ${creditAmount.toFixed(2)}. New balance: GHS ${newBalance.toFixed(2)}`,
                type: 'wallet_topup_success',
                reference: reference
              }).catch(() => {})
            }
          }
        }
      }
    } else if (event.event === "charge.failed") {
      const { reference, gateway_response } = event.data
      await supabase.from("wallet_payments").update({ status: "failed", updated_at: new Date().toISOString() }).eq("reference", reference)
      await supabase.from("payment_attempts").update({ status: "failed", gateway_response: gateway_response || "failed" }).eq("reference", reference)
    }

    return NextResponse.json({ received: true })
  } catch (error) {
    console.error("[WEBHOOK] ✗ Error:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
