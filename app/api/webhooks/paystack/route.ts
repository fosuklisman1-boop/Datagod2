import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import crypto from "crypto"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"

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

      // Handle USSD shop token purchases (MoMo) — reference is USSD-SHOP-... prefixed
      const { data: shopTokenPurchase, error: stpErr } = await supabase
        .from("ussd_shop_token_purchases")
        .select("id, shop_code_id, shop_id, tokens_purchased, amount_paid, payment_status, is_activation")
        .eq("paystack_reference", reference)
        .maybeSingle()

      if (stpErr) {
        console.warn("[WEBHOOK] ussd_shop_token_purchases lookup error (table may not exist):", stpErr.message)
      }

      if (shopTokenPurchase) {
        // This is a USSD shop payment — never fall through to wallet_payments
        if (shopTokenPurchase.payment_status !== 'pending') {
          console.log("[WEBHOOK] USSD shop token purchase already processed:", shopTokenPurchase.id, "status:", shopTokenPurchase.payment_status)
          return NextResponse.json({ received: true })
        }

        console.log("[WEBHOOK] Processing USSD shop token purchase:", shopTokenPurchase.id, "is_activation:", shopTokenPurchase.is_activation)

        const { error: statusErr } = await supabase
          .from("ussd_shop_token_purchases")
          .update({ payment_status: 'completed', updated_at: new Date().toISOString() })
          .eq("id", shopTokenPurchase.id)

        if (statusErr) {
          console.error("[WEBHOOK] Failed to update purchase payment_status:", statusErr)
          return NextResponse.json({ error: "DB update failed" }, { status: 500 })
        }
        console.log("[WEBHOOK] ✓ purchase payment_status set to completed")

        if (shopTokenPurchase.is_activation) {
          const { error: activateErr } = await supabase
            .from("ussd_shop_codes")
            .update({
              status: 'active',
              activation_fee_paid: true,
              activation_paid_at: new Date().toISOString(),
              token_balance: shopTokenPurchase.tokens_purchased,
              updated_at: new Date().toISOString(),
            })
            .eq("id", shopTokenPurchase.shop_code_id)
          if (activateErr) console.error("[WEBHOOK] Failed to activate shop code:", activateErr)
          else console.log("[WEBHOOK] ✓ USSD shop code activated:", shopTokenPurchase.shop_code_id)
        } else {
          const { data: codeRow } = await supabase
            .from("ussd_shop_codes").select("token_balance").eq("id", shopTokenPurchase.shop_code_id).single()
          if (codeRow) {
            const { error: creditErr } = await supabase
              .from("ussd_shop_codes")
              .update({ token_balance: codeRow.token_balance + shopTokenPurchase.tokens_purchased, updated_at: new Date().toISOString() })
              .eq("id", shopTokenPurchase.shop_code_id)
            if (creditErr) console.error("[WEBHOOK] Failed to credit tokens:", creditErr)
            else console.log("[WEBHOOK] ✓ USSD shop tokens credited:", shopTokenPurchase.tokens_purchased, "to code:", shopTokenPurchase.shop_code_id)
          }
        }

        return NextResponse.json({ received: true })
      }

      // Handle USSD orders first — they don't create wallet_payments records.
      // Look up by reference directly: the Paystack reference IS the ussd_order UUID.
      // This avoids relying on metadata, which Paystack doesn't always return
      // in charge.success events for mobile money charges.
      const { data: ussdOrder } = await supabase
        .from("ussd_orders")
        .select("*")
        .eq("id", reference)
        .maybeSingle()

      if (ussdOrder) {
        const ussdOrderId: string = ussdOrder.id
        console.log("[WEBHOOK] Processing USSD order:", ussdOrderId)

        if (ussdOrder.payment_status !== 'pending' && ussdOrder.payment_status !== 'otp_required') {
          console.log("[WEBHOOK] USSD order already processed:", ussdOrderId)
          return NextResponse.json({ received: true })
        }

        // Verify amount matches (security check)
        const paidGhs = amount / 100
        const expectedGhs = Number(ussdOrder.amount)
        if (paidGhs < expectedGhs - 0.01) {
          console.error(`[WEBHOOK] USSD underpayment! Paid: ${paidGhs}, Expected: ${expectedGhs}`)
          return NextResponse.json({ error: "Underpayment" }, { status: 400 })
        }

        // Mark payment completed — leave order_status as pending until fulfillment resolves
        await supabase
          .from("ussd_orders")
          .update({
            payment_status: 'completed',
            paystack_reference: reference,
            updated_at: new Date().toISOString(),
          })
          .eq("id", ussdOrderId)

        // Update payment_attempts record so admin pages reflect the completed status
        await supabase
          .from("payment_attempts")
          .update({ status: 'completed', completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("reference", ussdOrderId)
          .eq("payment_type", "ussd")

        // Trigger fulfillment directly (avoids shop_order coupling of /api/fulfillment/process-order)
        try {
          const { fulfillUssdOrder } = await import("@/lib/ussd/fulfill")
          const fulfillResult = await fulfillUssdOrder(
            ussdOrderId,
            ussdOrder.network,
            ussdOrder.recipient_phone,
            ussdOrder.package_size ?? ''
          )
          if (fulfillResult.success) {
            console.log("[WEBHOOK] ✓ USSD fulfillment triggered:", fulfillResult.message)
          } else {
            console.error("[WEBHOOK] USSD fulfillment failed:", fulfillResult.message)
          }
        } catch (fErr) {
          console.error("[WEBHOOK] Failed to trigger USSD fulfillment:", fErr)
          await supabase
            .from("ussd_orders")
            .update({ order_status: 'pending', updated_at: new Date().toISOString() })
            .eq("id", ussdOrderId)
        }

        // Credit parent shop profit for sub-agent orders
        if (ussdOrder.parent_shop_id && Number(ussdOrder.parent_profit_amount) > 0) {
          const { error: profitErr } = await supabase
            .from("shop_profits")
            .insert([{
              shop_id: ussdOrder.parent_shop_id,
              ussd_order_id: ussdOrderId,
              profit_amount: ussdOrder.parent_profit_amount,
              status: "credited",
              created_at: new Date().toISOString(),
            }])
          if (profitErr) {
            console.error("[WEBHOOK] Failed to insert parent profit for USSD sub-agent order:", profitErr)
          } else {
            console.log(`[WEBHOOK] ✓ Parent shop profit credited: GHS ${ussdOrder.parent_profit_amount} for shop ${ussdOrder.parent_shop_id}`)
          }
        }

        // SMS to recipient
        try {
          await sendSMS({
            phone: ussdOrder.recipient_phone,
            message: SMSTemplates.ussdOrderConfirmed(ussdOrder.package_size, ussdOrder.network),
            type: 'order_confirmation',
            reference: ussdOrderId,
          })
        } catch (smsErr) {
          console.warn("[WEBHOOK] USSD recipient SMS failed:", smsErr)
        }

        // SMS to payer (dialing phone) if different from recipient
        if (ussdOrder.dialing_phone && ussdOrder.dialing_phone !== ussdOrder.recipient_phone) {
          try {
            await sendSMS({
              phone: ussdOrder.dialing_phone,
              message: SMSTemplates.ussdPaymentConfirmed(ussdOrder.package_size, ussdOrder.network, ussdOrder.recipient_phone?.slice(-4).padStart(ussdOrder.recipient_phone.length, '*') ?? ''),
              type: 'order_confirmation',
              reference: ussdOrderId,
            })
          } catch (smsErr) {
            console.warn("[WEBHOOK] USSD payer SMS failed:", smsErr)
          }
        }

        return NextResponse.json({ received: true })
      }

      // Handle USSD AFA orders (no wallet_payments record; reference IS the order UUID)
      const { data: ussdAfaOrder } = await supabase
        .from("ussd_afa_orders")
        .select("id, amount, payment_status, dialing_phone")
        .eq("id", reference)
        .maybeSingle()

      if (ussdAfaOrder) {
        console.log("[WEBHOOK] Processing USSD AFA order:", ussdAfaOrder.id)

        if (ussdAfaOrder.payment_status !== 'pending') {
          console.log("[WEBHOOK] USSD AFA order already processed:", ussdAfaOrder.id)
          return NextResponse.json({ received: true })
        }

        const paidGhs = amount / 100
        const expectedGhs = Number(ussdAfaOrder.amount)
        if (paidGhs < expectedGhs - 0.01) {
          console.error(`[WEBHOOK] USSD AFA underpayment! Paid: ${paidGhs}, Expected: ${expectedGhs}`)
          return NextResponse.json({ error: "Underpayment" }, { status: 400 })
        }

        await supabase
          .from("ussd_afa_orders")
          .update({ payment_status: 'completed', paystack_reference: reference, updated_at: new Date().toISOString() })
          .eq("id", ussdAfaOrder.id)

        try {
          const { fulfillUssdAfaOrder } = await import("@/lib/ussd/fulfill-afa")
          const result = await fulfillUssdAfaOrder(ussdAfaOrder.id)
          if (result.success) {
            console.log("[WEBHOOK] ✓ USSD AFA fulfilled:", ussdAfaOrder.id)
          } else {
            console.error("[WEBHOOK] USSD AFA fulfillment failed:", result.message)
          }
        } catch (fErr) {
          console.error("[WEBHOOK] Failed to trigger USSD AFA fulfillment:", fErr)
        }

        // SMS to payer confirming registration received
        try {
          await sendSMS({
            phone: ussdAfaOrder.dialing_phone,
            message: SMSTemplates.ussdAfaPaymentReceived(),
            type: 'order_confirmation',
            reference: ussdAfaOrder.id,
          })
        } catch (smsErr) {
          console.warn("[WEBHOOK] USSD AFA SMS failed:", smsErr)
        }

        return NextResponse.json({ received: true })
      }

      // Handle USSD shop orders (reference IS the ussd_shop_order UUID)
      const { data: ussdShopOrder } = await supabase
        .from("ussd_shop_orders")
        .select("*")
        .eq("id", reference)
        .maybeSingle()

      if (ussdShopOrder) {
        console.log("[WEBHOOK] Processing USSD shop order:", ussdShopOrder.id)

        if (ussdShopOrder.payment_status !== 'pending' && ussdShopOrder.payment_status !== 'otp_required') {
          console.log("[WEBHOOK] USSD shop order already processed:", ussdShopOrder.id)
          return NextResponse.json({ received: true })
        }

        const paidGhs = amount / 100
        const expectedGhs = Number(ussdShopOrder.amount)
        if (paidGhs < expectedGhs - 0.01) {
          console.error(`[WEBHOOK] USSD shop underpayment! Paid: ${paidGhs}, Expected: ${expectedGhs}`)
          return NextResponse.json({ error: "Underpayment" }, { status: 400 })
        }

        await supabase
          .from("ussd_shop_orders")
          .update({
            payment_status: 'completed',
            paystack_reference: reference,
            updated_at: new Date().toISOString(),
          })
          .eq("id", ussdShopOrder.id)

        // Credit shop profit (DB trigger auto-syncs shop_available_balance)
        if (Number(ussdShopOrder.profit_amount) > 0) {
          const { error: profitErr } = await supabase.from("shop_profits").insert([{
            shop_id: ussdShopOrder.shop_id,
            ussd_shop_order_id: ussdShopOrder.id,
            profit_amount: ussdShopOrder.profit_amount,
            status: "credited",
            created_at: new Date().toISOString(),
          }])
          if (profitErr) {
            console.error("[WEBHOOK] Failed to credit USSD shop profit:", profitErr)
          } else {
            console.log(`[WEBHOOK] ✓ Shop profit credited: GHS ${ussdShopOrder.profit_amount} for shop ${ussdShopOrder.shop_id}`)
          }
        }

        // Update payment_attempts
        await supabase
          .from("payment_attempts")
          .update({ status: 'completed', completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("reference", ussdShopOrder.id)
          .eq("payment_type", "ussd_shop")

        // Trigger fulfillment
        try {
          const { fulfillUssdOrder } = await import("@/lib/ussd/fulfill")
          const fulfillResult = await fulfillUssdOrder(
            ussdShopOrder.id,
            ussdShopOrder.network,
            ussdShopOrder.recipient_phone,
            ussdShopOrder.package_size ?? ''
          )
          // fulfillUssdOrder updates ussd_orders internally; update ussd_shop_orders separately
          const newOrderStatus = fulfillResult.success ? 'processing' : 'pending'
          await supabase
            .from("ussd_shop_orders")
            .update({ order_status: newOrderStatus, updated_at: new Date().toISOString() })
            .eq("id", ussdShopOrder.id)
          if (fulfillResult.success) {
            console.log("[WEBHOOK] ✓ USSD shop fulfillment triggered:", fulfillResult.message)
          } else {
            console.error("[WEBHOOK] USSD shop fulfillment failed:", fulfillResult.message)
          }
        } catch (fErr) {
          console.error("[WEBHOOK] Failed to trigger USSD shop fulfillment:", fErr)
          await supabase
            .from("ussd_shop_orders")
            .update({ order_status: 'failed', updated_at: new Date().toISOString() })
            .eq("id", ussdShopOrder.id)
        }

        // SMS to recipient
        try {
          await sendSMS({
            phone: ussdShopOrder.recipient_phone,
            message: SMSTemplates.ussdOrderConfirmed(ussdShopOrder.package_size, ussdShopOrder.network),
            type: 'order_confirmation',
            reference: ussdShopOrder.id,
          })
        } catch (smsErr) {
          console.warn("[WEBHOOK] USSD shop SMS failed:", smsErr)
        }

        return NextResponse.json({ received: true })
      }

      // Find and update payment record (for non-USSD payments)
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
      const isResultsChecker = (paymentData.order_type === "results_checker") || (metadata?.orderType === "results_checker")
      const isUssdShopActivation = paymentData.order_type === "ussd_shop_activation"
      const isUssdShopToken = paymentData.order_type === "ussd_shop_token"
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
        } else if (isResultsChecker) {
          const { data: rcOrder } = await supabase
            .from("results_checker_orders")
            .select("total_paid")
            .eq("id", paymentData.order_id)
            .single()

          if (rcOrder) {
            verifiedTotalPrice = Number(rcOrder.total_paid)
          }
        } else if (isUssdShopActivation || isUssdShopToken) {
          // amount is set explicitly at charge time — no separate order record to verify against
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

      // Overpayments are accepted and flow as normal orders

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

      // Handle USSD shop activation / token purchases
      if (isUssdShopActivation || isUssdShopToken) {
        const { data: purchase } = await supabase
          .from("ussd_shop_token_purchases")
          .select("id, shop_code_id, tokens_purchased, payment_status")
          .eq("id", paymentData.order_id)
          .single()

        if (!purchase) {
          console.error("[WEBHOOK] ussd_shop_token_purchases record not found:", paymentData.order_id)
          return NextResponse.json({ received: true })
        }

        if (purchase.payment_status !== 'pending') {
          console.log("[WEBHOOK] USSD shop purchase already processed:", purchase.id)
          return NextResponse.json({ received: true })
        }

        const { error: purchaseUpdateErr } = await supabase
          .from("ussd_shop_token_purchases")
          .update({ payment_status: 'completed', updated_at: new Date().toISOString() })
          .eq("id", purchase.id)

        if (purchaseUpdateErr) {
          console.error("[WEBHOOK] Failed to update ussd_shop_token_purchases:", purchaseUpdateErr)
        } else {
          console.log("[WEBHOOK] ✓ purchase payment_status set to completed")
        }

        if (isUssdShopActivation) {
          const { error: activateErr } = await supabase
            .from("ussd_shop_codes")
            .update({
              status: 'active',
              activation_fee_paid: true,
              activation_paid_at: new Date().toISOString(),
              token_balance: purchase.tokens_purchased,
              updated_at: new Date().toISOString(),
            })
            .eq("id", purchase.shop_code_id)
          if (activateErr) console.error("[WEBHOOK] Failed to activate shop code:", activateErr)
          else console.log("[WEBHOOK] ✓ USSD shop code activated:", purchase.shop_code_id)
        } else {
          const { data: codeRow } = await supabase
            .from("ussd_shop_codes").select("token_balance").eq("id", purchase.shop_code_id).single()
          if (codeRow) {
            const { error: creditErr } = await supabase
              .from("ussd_shop_codes")
              .update({ token_balance: codeRow.token_balance + purchase.tokens_purchased, updated_at: new Date().toISOString() })
              .eq("id", purchase.shop_code_id)
            if (creditErr) console.error("[WEBHOOK] Failed to credit tokens:", creditErr)
            else console.log("[WEBHOOK] ✓ USSD shop tokens credited:", purchase.tokens_purchased)
          }
        }

        return NextResponse.json({ received: true })
      }

      // 1. Handle Shop Orders and Airtime
      if (paymentData.order_id && !isDealerUpgrade) {
        if (!isAirtime && !isResultsChecker) {
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
        } else if (isAirtime) {
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
        } else if (isResultsChecker) {
          // Results Checker voucher guest payment
          const { data: rcOrder } = await supabase
            .from("results_checker_orders")
            .select("*")
            .eq("id", paymentData.order_id)
            .single()

          if (rcOrder && rcOrder.status !== "completed" && rcOrder.status !== "failed") {
            // Atomically assign and finalize vouchers
            const { data: vouchers, error: assignError } = await supabase.rpc(
              "assign_results_checker_vouchers",
              { p_exam_board: rcOrder.exam_board, p_quantity: rcOrder.quantity, p_order_id: rcOrder.id }
            )

            if (assignError || !vouchers || vouchers.length < rcOrder.quantity) {
              console.warn(`[WEBHOOK] ⚠ RC voucher stock exhausted for order ${rcOrder.id} — marking pending`)
              await supabase
                .from("results_checker_orders")
                .update({ status: "pending", payment_status: "completed", updated_at: new Date().toISOString() })
                .eq("id", rcOrder.id)
            } else {
              await supabase.rpc("finalize_results_checker_sale", { p_order_id: rcOrder.id, p_user_id: null })

              const inventoryIds = vouchers.map((v: { id: string }) => v.id)
              const { error: rcUpdateErr } = await supabase
                .from("results_checker_orders")
                .update({
                  status: "completed",
                  payment_status: "completed",
                  inventory_ids: inventoryIds,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", rcOrder.id)

              if (rcUpdateErr) console.error("[WEBHOOK] ❌ Failed to mark RC order completed:", rcUpdateErr)

              if (rcOrder.merchant_commission > 0 && rcOrder.shop_id) {
                const { error: rcProfitError } = await supabase.from("shop_profits").insert([{
                  shop_id: rcOrder.shop_id,
                  results_checker_order_id: rcOrder.id,
                  profit_amount: rcOrder.merchant_commission,
                  status: "credited",
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                }])
                if (rcProfitError) {
                  if (rcProfitError.code !== "23505") {
                    // Fallback: insert without FK column if migration 0045 not yet applied
                    await supabase.from("shop_profits").insert([{
                      shop_id: rcOrder.shop_id,
                      profit_amount: rcOrder.merchant_commission,
                      status: "credited",
                      created_at: new Date().toISOString(),
                      updated_at: new Date().toISOString(),
                    }]).then(({ error: e }) => {
                      if (e && e.code !== "23505") console.error("[WEBHOOK] ❌ RC profit fallback failed:", e.message)
                    })
                  }
                } else {
                  console.log(`[WEBHOOK] ✓ RC profit recorded: GHS ${rcOrder.merchant_commission}`)
                }
              }

              // Deliver vouchers to guest (non-blocking)
              import("@/lib/results-checker-notification-service").then(({ deliverVouchers }) => {
                return deliverVouchers(rcOrder, vouchers)
              }).catch(e => console.warn("[WEBHOOK] RC delivery error:", e))

              console.log(`[WEBHOOK] ✓ RC order ${rcOrder.reference_code} completed: ${rcOrder.quantity}x ${rcOrder.exam_board}`)
            }
          } else if (rcOrder?.status === "completed") {
            console.log(`[WEBHOOK] ℹ RC order ${rcOrder.reference_code} already completed — skipping`)
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
                   message: SMSTemplates.dealerUpgraded(),
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
        if (!paymentData.user_id) {
          console.error(`[WEBHOOK] ❌ CRITICAL: Wallet top-up failed for reference ${reference}. User ID is NULL in the database. This usually means the payment was initialized without an Authorization header or by a guest user.`)
          return NextResponse.json({ received: true }) // Still return 200 to Paystack
        }

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
                message: SMSTemplates.walletToppedUp(userData.first_name || 'User', creditAmount.toFixed(2), newBalance.toFixed(2)),
                type: 'wallet_topup_success',
                reference: reference
              }).catch(() => {})
            }
          }
        }
      }
    } else if (event.event === "charge.failed") {
      const { reference, gateway_response } = event.data

      // Handle failed USSD shop token/activation charges
      try {
        const { data: failedPurchase } = await supabase
          .from("wallet_payments")
          .select("id, order_id, order_type")
          .eq("reference", reference)
          .in("order_type", ["ussd_shop_activation", "ussd_shop_token"])
          .maybeSingle()
        if (failedPurchase) {
          await supabase.from("wallet_payments").update({ status: 'failed', updated_at: new Date().toISOString() }).eq("id", failedPurchase.id)
          await supabase.from("ussd_shop_token_purchases").update({ payment_status: 'failed', updated_at: new Date().toISOString() }).eq("id", failedPurchase.order_id)
          console.log("[WEBHOOK] USSD shop purchase marked failed:", failedPurchase.order_id)
        }
      } catch (e) {
        console.warn("[WEBHOOK] Failed to mark USSD shop purchase failed:", e)
      }

      // Handle failed USSD charges — look up by id since reference IS the ussd_order UUID
      try {
        const { data: ussdOrder } = await supabase
          .from("ussd_orders")
          .select("id")
          .eq("id", reference)
          .maybeSingle()
        if (ussdOrder) {
          await supabase
            .from("ussd_orders")
            .update({ payment_status: 'failed', order_status: 'failed', updated_at: new Date().toISOString() })
            .eq("id", ussdOrder.id)
          await supabase
            .from("payment_attempts")
            .update({ status: 'failed', gateway_response: gateway_response || 'failed', updated_at: new Date().toISOString() })
            .eq("reference", ussdOrder.id)
            .eq("payment_type", "ussd")
          console.log("[WEBHOOK] USSD order marked failed:", ussdOrder.id)
        }
      } catch (e) {
        console.warn("[WEBHOOK] Failed to update failed USSD order:", e)
      }

      // Handle failed USSD AFA charges
      try {
        const { data: afaOrder } = await supabase
          .from("ussd_afa_orders")
          .select("id")
          .eq("id", reference)
          .maybeSingle()
        if (afaOrder) {
          await supabase
            .from("ussd_afa_orders")
            .update({ payment_status: 'failed', order_status: 'failed', updated_at: new Date().toISOString() })
            .eq("id", afaOrder.id)
          console.log("[WEBHOOK] USSD AFA order marked failed:", afaOrder.id)
        }
      } catch (e) {
        console.warn("[WEBHOOK] Failed to update failed USSD AFA order:", e)
      }

      // Handle failed USSD shop charges
      try {
        const { data: shopOrder } = await supabase
          .from("ussd_shop_orders")
          .select("id")
          .eq("id", reference)
          .maybeSingle()
        if (shopOrder) {
          await supabase
            .from("ussd_shop_orders")
            .update({ payment_status: 'failed', order_status: 'failed', updated_at: new Date().toISOString() })
            .eq("id", shopOrder.id)
          await supabase
            .from("payment_attempts")
            .update({ status: 'failed', gateway_response: gateway_response || 'failed', updated_at: new Date().toISOString() })
            .eq("reference", shopOrder.id)
            .eq("payment_type", "ussd_shop")
          console.log("[WEBHOOK] USSD shop order marked failed:", shopOrder.id)
        }
      } catch (e) {
        console.warn("[WEBHOOK] Failed to update failed USSD shop order:", e)
      }

      await supabase.from("wallet_payments").update({ status: "failed", updated_at: new Date().toISOString() }).eq("reference", reference)
      await supabase.from("payment_attempts").update({ status: "failed", gateway_response: gateway_response || "failed" }).eq("reference", reference)
    }

    return NextResponse.json({ received: true })
  } catch (error) {
    console.error("[WEBHOOK] ✗ Error:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
