import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import crypto from "crypto"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import { getJoinCommunityLink } from "@/lib/app-settings"
import { sendPushToUser } from "@/lib/push-service"
import { getInternalBaseUrl } from "@/lib/internal-url"

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

    // Timing-safe comparison — sha512 hex is 128 chars so a string `===` would
    // leak side-channel timing info to a high-precision local attacker. In
    // practice not exploitable over the public internet but textbook-wrong.
    const expectedBuf = Buffer.from(hash, "hex")
    const actualBuf = Buffer.from(signature, "hex")
    if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
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
          // Atomic increment — avoids the read-then-write race when Paystack retries
          // the webhook concurrently (see migration 0051).
          const { error: creditErr } = await supabase.rpc("increment_ussd_token_balance", {
            p_shop_code_id: shopTokenPurchase.shop_code_id,
            p_amount: shopTokenPurchase.tokens_purchased,
          })
          if (creditErr) console.error("[WEBHOOK] Failed to credit tokens:", creditErr)
          else console.log("[WEBHOOK] ✓ USSD shop tokens credited:", shopTokenPurchase.tokens_purchased, "to code:", shopTokenPurchase.shop_code_id)
        }

        // Push notification to shop owner (non-blocking)
        ;(async () => {
          try {
            const { data: shopRow } = await supabase
              .from("user_shops").select("user_id").eq("id", shopTokenPurchase.shop_id).single()
            if (!shopRow?.user_id) return
            if (shopTokenPurchase.is_activation) {
              await sendPushToUser(shopRow.user_id, {
                title: "Shop Code Activated",
                body: `Your USSD shop code is now active with ${shopTokenPurchase.tokens_purchased} session${shopTokenPurchase.tokens_purchased !== 1 ? 's' : ''}.`,
                data: { url: `/dashboard/ussd-shop` },
              })
            } else {
              await sendPushToUser(shopRow.user_id, {
                title: "Sessions Purchased",
                body: `${shopTokenPurchase.tokens_purchased} session${shopTokenPurchase.tokens_purchased !== 1 ? 's' : ''} added to your shop.`,
                data: { url: `/dashboard/ussd-shop` },
              })
            }
          } catch { /* non-fatal */ }
        })()

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
          const channelLink = await getJoinCommunityLink()
          await sendSMS({
            phone: ussdOrder.recipient_phone,
            message: SMSTemplates.ussdOrderConfirmed(ussdOrder.package_size, ussdOrder.network, channelLink),
            type: 'order_confirmation',
            reference: ussdOrderId,
          })
        } catch (smsErr) {
          console.warn("[WEBHOOK] USSD recipient SMS failed:", smsErr)
        }

        // SMS to payer (dialing phone) only if it's a DIFFERENT number from the
        // recipient. Payer and recipient are often the same person stored in
        // different formats (e.g. 233534797023 vs 0534797023), so compare by the
        // last 9 digits — otherwise a self-purchase double-sends (and double-bills).
        const recipLast9 = (ussdOrder.recipient_phone || "").replace(/\D/g, "").slice(-9)
        const dialLast9 = (ussdOrder.dialing_phone || "").replace(/\D/g, "").slice(-9)
        if (ussdOrder.dialing_phone && dialLast9 && dialLast9 !== recipLast9) {
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

        // Credit sub-agent shop profit (DB trigger auto-syncs shop_available_balance)
        if (Number(ussdShopOrder.profit_amount) > 0) {
          const { error: profitErr } = await supabase.from("shop_profits").insert([{
            shop_id: ussdShopOrder.shop_id,
            ussd_shop_order_id: ussdShopOrder.id,
            profit_amount: ussdShopOrder.profit_amount,
            status: "credited",
            created_at: new Date().toISOString(),
          }])
          if (profitErr) {
            console.error("[WEBHOOK] Failed to credit USSD shop profit:", profitErr.message, profitErr.code, profitErr.details)
          } else {
            console.log(`[WEBHOOK] ✓ Shop profit credited: GHS ${ussdShopOrder.profit_amount} for shop ${ussdShopOrder.shop_id}`)
          }
        } else {
          console.log(`[WEBHOOK] USSD shop profit_amount is ${ussdShopOrder.profit_amount} — skipping profit insert for order ${ussdShopOrder.id}`)
        }

        // Credit parent shop wholesale margin (sub-agent orders only)
        if (ussdShopOrder.parent_shop_id && Number(ussdShopOrder.parent_profit_amount) > 0) {
          const { error: parentProfitErr } = await supabase.from("shop_profits").insert([{
            shop_id: ussdShopOrder.parent_shop_id,
            ussd_shop_order_id: ussdShopOrder.id,
            profit_amount: ussdShopOrder.parent_profit_amount,
            status: "credited",
            created_at: new Date().toISOString(),
          }])
          if (parentProfitErr) {
            console.error("[WEBHOOK] Failed to credit parent shop profit for USSD sub-agent order:", parentProfitErr.message, parentProfitErr.code, parentProfitErr.details)
          } else {
            console.log(`[WEBHOOK] ✓ Parent shop profit credited: GHS ${ussdShopOrder.parent_profit_amount} for shop ${ussdShopOrder.parent_shop_id}`)
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
            ussdShopOrder.package_size ?? '',
            false,
            "ussd_shop_orders"
          )
          // Do NOT override order_status here. fulfillUssdOrder already set the
          // precise status: 'processing' when actually placed with a provider,
          // 'pending' when queued for manual (auto off / unknown network),
          // 'failed' on blacklist. Forcing success→'processing' previously
          // stranded auto-off orders in 'processing' (invisible to the manual
          // queue). This matches the main-USSD path, which also trusts the
          // internal status.
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

        // SMS to recipient (USSD shop orders intentionally omit the channel link)
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

      // Handle USSD airtime orders (direct charge; reference IS the airtime_orders UUID).
      // Storefront airtime is charged with a WALLET-… reference and resolved via
      // wallet_payments below, so this id-lookup only ever matches USSD orders.
      const { data: ussdAirtimeOrder } = await supabase
        .from("airtime_orders")
        .select("id, total_paid, payment_status, dialing_phone, beneficiary_phone, network, airtime_amount, reference_code, channel")
        .eq("id", reference)
        .maybeSingle()

      if (ussdAirtimeOrder) {
        console.log("[WEBHOOK] Processing USSD airtime order:", ussdAirtimeOrder.id)

        if (ussdAirtimeOrder.payment_status === 'completed') {
          console.log("[WEBHOOK] USSD airtime order already processed:", ussdAirtimeOrder.id)
          return NextResponse.json({ received: true })
        }

        const paidGhs = amount / 100
        const expectedGhs = Number(ussdAirtimeOrder.total_paid)
        if (paidGhs < expectedGhs - 0.01) {
          console.error(`[WEBHOOK] USSD airtime underpayment! Paid: ${paidGhs}, Expected: ${expectedGhs}`)
          return NextResponse.json({ error: "Underpayment" }, { status: 400 })
        }

        const { markAirtimeOrderPaid } = await import("@/lib/airtime-service")
        await markAirtimeOrderPaid(ussdAirtimeOrder.id, event.data.id)

        await supabase
          .from("payment_attempts")
          .update({ status: 'completed', completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("reference", ussdAirtimeOrder.id)

        // Notify beneficiary (and payer, if different) that payment landed and
        // airtime is being processed. Airtime is fulfilled manually, so do NOT
        // claim it has already been delivered.
        const benef = ussdAirtimeOrder.beneficiary_phone as string
        const payer = ussdAirtimeOrder.dialing_phone as string | null
        const airtimeMsg = SMSTemplates.ussdAirtimePaymentReceived(
          Number(ussdAirtimeOrder.airtime_amount).toFixed(2),
          ussdAirtimeOrder.network,
          benef,
        )
        try {
          await sendSMS({ phone: benef, message: airtimeMsg, type: 'airtime_order_created', reference: ussdAirtimeOrder.id })
        } catch (smsErr) { console.warn("[WEBHOOK] USSD airtime beneficiary SMS failed:", smsErr) }
        const benefLast9 = (benef || "").replace(/\D/g, "").slice(-9)
        const payerLast9 = (payer || "").replace(/\D/g, "").slice(-9)
        if (payer && payerLast9 && payerLast9 !== benefLast9) {
          try {
            await sendSMS({ phone: payer, message: airtimeMsg, type: 'airtime_order_created', reference: ussdAirtimeOrder.id })
          } catch (smsErr) { console.warn("[WEBHOOK] USSD airtime payer SMS failed:", smsErr) }
        }

        return NextResponse.json({ received: true })
      }

      // Handle USSD results-checker orders (direct charge; reference IS the
      // results_checker_orders UUID). Storefront RC uses a WALLET-… reference.
      const { data: ussdRcOrder } = await supabase
        .from("results_checker_orders")
        .select("id, total_paid, payment_status, status")
        .eq("id", reference)
        .maybeSingle()

      if (ussdRcOrder) {
        console.log("[WEBHOOK] Processing USSD results-checker order:", ussdRcOrder.id)

        if (ussdRcOrder.status === 'completed') {
          console.log("[WEBHOOK] USSD RC order already completed:", ussdRcOrder.id)
          return NextResponse.json({ received: true })
        }

        const paidGhs = amount / 100
        const expectedGhs = Number(ussdRcOrder.total_paid)
        if (paidGhs < expectedGhs - 0.01) {
          console.error(`[WEBHOOK] USSD RC underpayment! Paid: ${paidGhs}, Expected: ${expectedGhs}`)
          return NextResponse.json({ error: "Underpayment" }, { status: 400 })
        }

        await supabase
          .from("payment_attempts")
          .update({ status: 'completed', completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("reference", ussdRcOrder.id)

        // Assign + finalize + deliver vouchers (delivery goes to customer_phone,
        // which the USSD handler sets to the caller's number).
        const { fulfillPaidResultsCheckerOrder } = await import("@/lib/results-checker-service")
        const rcResult = await fulfillPaidResultsCheckerOrder(ussdRcOrder.id)
        if (!rcResult.success) {
          console.warn("[WEBHOOK] USSD RC fulfillment incomplete:", rcResult.status, rcResult.message)
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
          .select("id, shop_code_id, shop_id, tokens_purchased, payment_status")
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
          // Atomic increment — avoids the read-then-write race when Paystack retries
          // the webhook concurrently (see migration 0051).
          const { error: creditErr } = await supabase.rpc("increment_ussd_token_balance", {
            p_shop_code_id: purchase.shop_code_id,
            p_amount: purchase.tokens_purchased,
          })
          if (creditErr) console.error("[WEBHOOK] Failed to credit tokens:", creditErr)
          else console.log("[WEBHOOK] ✓ USSD shop tokens credited:", purchase.tokens_purchased)
        }

        // Push notification to shop owner (non-blocking)
        ;(async () => {
          try {
            const { data: shopRow } = await supabase
              .from("user_shops").select("user_id").eq("id", purchase.shop_id).single()
            if (!shopRow?.user_id) return
            if (isUssdShopActivation) {
              await sendPushToUser(shopRow.user_id, {
                title: "Shop Code Activated",
                body: `Your USSD shop code is now active with ${purchase.tokens_purchased} session${purchase.tokens_purchased !== 1 ? 's' : ''}.`,
                data: { url: `/dashboard/ussd-shop` },
              })
            } else {
              await sendPushToUser(shopRow.user_id, {
                title: "Sessions Purchased",
                body: `${purchase.tokens_purchased} session${purchase.tokens_purchased !== 1 ? 's' : ''} added to your shop.`,
                data: { url: `/dashboard/ussd-shop` },
              })
            }
          } catch { /* non-fatal */ }
        })()

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

            // Push shop owner — payment confirmed
            Promise.resolve(supabase.from('user_shops').select('user_id').eq('id', paymentData.shop_id).single()).then(({ data: shop }) => {
              if (shop?.user_id) {
                sendPushToUser(shop.user_id, {
                  title: '🛒 Order Paid',
                  body: `${shopOrderData.network} ${shopOrderData.volume_gb}GB → ${shopOrderData.customer_phone} (GHS ${shopOrderData.total_price?.toFixed(2)})`,
                  data: { url: '/dashboard/shop-dashboard' },
                }).catch(() => {})
              }
            }).catch(() => {})

            // Auto-fulfillment trigger via unified endpoint.
            // IMPORTANT: use the INTERNAL origin (Vercel) — NOT the public
            // Cloudflare-proxied domain. A server-to-server call to the public
            // domain has no browser fingerprint and gets hit by Cloudflare Bot
            // Fight Mode, which returns an HTML challenge page → JSON.parse
            // crash → fulfillment silently fails for PAID orders.
            try {
              const baseUrl = getInternalBaseUrl()
              const digits = shopOrderData.volume_gb?.toString().replace(/[^0-9]/g, "") || "0"
              const sizeGb = parseInt(digits) || 0

              console.log(`[WEBHOOK] Triggering unified fulfillment for shop order ${paymentData.order_id} via ${baseUrl}`)

              const fulfillmentResponse = await fetch(`${baseUrl}/api/fulfillment/process-order`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "x-internal-secret": process.env.INTERNAL_API_SECRET ?? "",
                },
                body: JSON.stringify({
                  shop_order_id: paymentData.order_id,
                  network: shopOrderData.network,
                  phone_number: shopOrderData.customer_phone,
                  volume_gb: sizeGb,
                  customer_name: shopOrderData.customer_name,
                }),
              })

              // Robust parse: a non-JSON body (e.g. a Cloudflare challenge HTML
              // page) must NOT crash the handler. Leave the order pending so the
              // verify-pending-payments cron retries fulfillment.
              const ct = fulfillmentResponse.headers.get("content-type") || ""
              if (!ct.includes("application/json")) {
                const text = await fulfillmentResponse.text()
                console.error(`[WEBHOOK] ⚠️ Fulfillment returned non-JSON (status ${fulfillmentResponse.status}, content-type ${ct}). First 120 chars: ${text.slice(0, 120)}. Order ${paymentData.order_id} left pending for cron retry.`)
              } else {
                const fulfillmentResult = await fulfillmentResponse.json()
                if (!fulfillmentResponse.ok) {
                  console.error("[WEBHOOK] Unified fulfillment error:", fulfillmentResult)
                } else {
                  console.log("[WEBHOOK] ✓ Unified fulfillment triggered successfully")
                }
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
          // Airtime: mark paid + record merchant profit (shared with USSD path).
          const { markAirtimeOrderPaid } = await import("@/lib/airtime-service")
          await markAirtimeOrderPaid(paymentData.order_id, event.data.id)
        } else if (isResultsChecker) {
          // Results Checker voucher payment — assign/finalize/deliver + profit
          // (shared with the USSD path).
          const { fulfillPaidResultsCheckerOrder } = await import("@/lib/results-checker-service")
          await fulfillPaidResultsCheckerOrder(paymentData.order_id)
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
            import('@/lib/push-service').then(({ notifyAdminsPush }) => {
              notifyAdminsPush({
                title: '💰 Wallet Top-up',
                body: `GHS ${creditAmount.toFixed(2)} topped up by ${userData?.first_name || 'a user'} — new balance: GHS ${newBalance.toFixed(2)}`,
                data: { url: '/admin/payment-attempts' },
              }).catch(() => {})
            }).catch(() => {})
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

      // Handle failed USSD airtime charges (reference IS the airtime_orders UUID)
      try {
        const { data: at } = await supabase
          .from("airtime_orders")
          .select("id, payment_status")
          .eq("id", reference)
          .maybeSingle()
        if (at && at.payment_status !== 'completed') {
          await supabase
            .from("airtime_orders")
            .update({ payment_status: 'failed', status: 'failed', updated_at: new Date().toISOString() })
            .eq("id", at.id)
          await supabase
            .from("payment_attempts")
            .update({ status: 'failed', gateway_response: gateway_response || 'failed', updated_at: new Date().toISOString() })
            .eq("reference", at.id)
          console.log("[WEBHOOK] USSD airtime order marked failed:", at.id)
        }
      } catch (e) {
        console.warn("[WEBHOOK] Failed to update failed USSD airtime order:", e)
      }

      // Handle failed USSD results-checker charges (reference IS the order UUID)
      try {
        const { data: rc } = await supabase
          .from("results_checker_orders")
          .select("id, status")
          .eq("id", reference)
          .maybeSingle()
        if (rc && rc.status !== 'completed') {
          await supabase
            .from("results_checker_orders")
            .update({ payment_status: 'failed', status: 'failed', updated_at: new Date().toISOString() })
            .eq("id", rc.id)
          await supabase
            .from("payment_attempts")
            .update({ status: 'failed', gateway_response: gateway_response || 'failed', updated_at: new Date().toISOString() })
            .eq("reference", rc.id)
          console.log("[WEBHOOK] USSD results-checker order marked failed:", rc.id)
        }
      } catch (e) {
        console.warn("[WEBHOOK] Failed to update failed USSD results-checker order:", e)
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
