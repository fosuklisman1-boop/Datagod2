import { NextRequest, NextResponse } from "next/server"
import { verifyPayment } from "@/lib/paystack"
import { createClient } from "@supabase/supabase-js"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import { atishareService } from "@/lib/at-ishare-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  try {
    const { reference } = await request.json()

    console.log("[PAYMENT-VERIFY] Request received:", reference)

    if (!reference) {
      return NextResponse.json(
        { error: "Payment reference is required" },
        { status: 400 }
      )
    }

    // Fetch payment record (select only needed columns)
    console.log("[PAYMENT-VERIFY] Fetching payment record...")
    const { data: paymentData, error: fetchError } = await supabase
      .from("wallet_payments")
      .select("id, user_id, reference, status, shop_id, order_id")
      .eq("reference", reference)
      .maybeSingle()

    if (fetchError || !paymentData) {
      console.warn("[PAYMENT-VERIFY] Payment not found:", reference)
      return NextResponse.json(
        { error: "Payment record not found" },
        { status: 404 }
      )
    }

    console.log("[PAYMENT-VERIFY] ✓ Record found - User:", paymentData.user_id)
    
    // Safety check: if already completed, don't verify again
    if (paymentData.status === "completed") {
      console.log("[PAYMENT-VERIFY] ℹ Payment already completed - skipping re-verification")
      return NextResponse.json({
        success: true,
        status: "completed",
        message: "Payment already verified and completed",
      })
    }

    // Verify with Paystack
    console.log("[PAYMENT-VERIFY] Verifying with Paystack...")
    const verificationResult = await verifyPayment(reference)

    console.log("[PAYMENT-VERIFY] ✓ Verified - Status:", verificationResult.status)

    // Update payment status
    const paymentStatus = verificationResult.status === "success" ? "completed" : verificationResult.status
    const { error: updateError } = await supabase
      .from("wallet_payments")
      .update({
        status: paymentStatus,
        amount_received: verificationResult.amount,
        updated_at: new Date().toISOString(),
      })
      .eq("id", paymentData.id)

    if (updateError) {
      console.error("[PAYMENT-VERIFY] Failed to update payment:", updateError)
      throw new Error("Failed to update payment status")
    }

    // Credit wallet if successful
    if (verificationResult.status === "success") {
      console.log("[PAYMENT-VERIFY] Payment verified as successful - Wallet will be credited by webhook")
      console.log("[PAYMENT-VERIFY] Amount to credit:", verificationResult.amount)

      // NOTE: Do NOT credit wallet here. The webhook will handle it.
      // This prevents double-crediting if both verify and webhook execute.
      // The webhook is the source of truth for wallet crediting.

      // If payment was for a shop order, update its payment status and create profit record
      if (paymentData.shop_id && paymentData.order_id) {
        console.log("[PAYMENT-VERIFY] Payment is for shop order. Updating shop order payment status...")
        
        // Find shop order by order_id from payment record
        const { data: shopOrderData, error: shopOrderFetchError } = await supabase
          .from("shop_orders")
          .select("id, profit_amount")
          .eq("id", paymentData.order_id)
          .single()

        if (!shopOrderFetchError && shopOrderData) {
          // Update payment status
          const { error: shopOrderUpdateError } = await supabase
            .from("shop_orders")
            .update({
              payment_status: "completed",
              updated_at: new Date().toISOString(),
            })
            .eq("id", shopOrderData.id)

          if (shopOrderUpdateError) {
            console.error("[PAYMENT-VERIFY] Failed to update shop order payment status:", shopOrderUpdateError)
          } else {
            console.log("[PAYMENT-VERIFY] ✓ Shop order payment status updated to completed")
            
            // Create profit record for shop owner
            console.log("[PAYMENT-VERIFY] Creating profit record for shop owner...")
            const profitAmount = shopOrderData.profit_amount || 0
            const { error: profitError } = await supabase
              .from("shop_profits")
              .insert([{
                shop_id: paymentData.shop_id,
                shop_order_id: shopOrderData.id,
                profit_amount: profitAmount,
                status: "pending",
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              }])

            if (profitError) {
              console.error("[PAYMENT-VERIFY] Failed to create profit record:", profitError)
            } else {
              console.log("[PAYMENT-VERIFY] ✓ Profit record created:", profitAmount)
            }

            // Trigger fulfillment for AT-iShare orders
            console.log("[PAYMENT-VERIFY] Checking if fulfillment needed for order:", shopOrderData.id)
            const { data: orderDetails } = await supabase
              .from("shop_orders")
              .select("id, network, volume_gb, customer_phone, customer_name")
              .eq("id", shopOrderData.id)
              .single()

            if (orderDetails && orderDetails.customer_phone) {
              console.log(`[PAYMENT-VERIFY] Shop order network: "${orderDetails.network}"`)
              
              // Route to unified fulfillment endpoint
              try {
                console.log(`[PAYMENT-VERIFY] Triggering unified fulfillment for order ${shopOrderData.id}`)
                const sizeGb = parseInt(orderDetails.volume_gb?.toString().replace(/[^0-9]/g, "") || "0") || 0
                
                const fulfillmentResponse = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/fulfillment/process-order`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    shop_order_id: shopOrderData.id,
                    network: orderDetails.network,
                    phone_number: orderDetails.customer_phone,
                    volume_gb: sizeGb,
                    customer_name: orderDetails.customer_name,
                  }),
                })

                const fulfillmentResult = await fulfillmentResponse.json()
                console.log(`[PAYMENT-VERIFY] Fulfillment result:`, fulfillmentResult)
              } catch (fulfillmentError) {
                console.error(`[PAYMENT-VERIFY] Error triggering fulfillment for shop order ${shopOrderData.id}:`, fulfillmentError)
                // Non-blocking: don't fail payment verification if fulfillment fails
              }
            } else {
              console.warn(`[PAYMENT-VERIFY] No customer data found for shop order ${shopOrderData.id}`)
            }
          }
        }
      }
    }

    console.log("[PAYMENT-VERIFY] ✓ Complete")

    return NextResponse.json({
      success: true,
      status: verificationResult.status,
      amount: verificationResult.amount,
      reference: verificationResult.reference,
      message:
        verificationResult.status === "success"
          ? "Payment verified! Wallet will be credited shortly."
          : `Payment ${verificationResult.status}`,
    })
  } catch (error) {
    console.error("[PAYMENT-VERIFY] ✗ Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Verification failed" },
      { status: 500 }
    )
  }
}
