import { NextRequest, NextResponse } from "next/server"
import { verifyPayment } from "@/lib/paystack"
import { createClient } from "@supabase/supabase-js"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import { atishareService } from "@/lib/at-ishare-service"
import { isPhoneBlacklisted } from "@/lib/blacklist"

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
      .select("id, user_id, reference, status, shop_id, order_id, order_type")
      .eq("reference", reference)
      .single()

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

    // CRITICAL SECURITY CHECK: Verify payment amount matches expected amount
    // First, get the expected amount from the payment record
    const { data: paymentAmountData } = await supabase
      .from("wallet_payments")
      .select("amount")
      .eq("id", paymentData.id)
      .single()

    const expectedAmount = paymentAmountData?.amount || 0
    const paidAmount = verificationResult.amount
    const tolerance = 0.01 // Allow 1 pesewa tolerance for rounding

    if (verificationResult.status === "success" && Math.abs(paidAmount - expectedAmount) > tolerance) {
      console.error(`[PAYMENT-VERIFY] ❌ PAYMENT AMOUNT MISMATCH! Paid: ${paidAmount}, Expected: ${expectedAmount}, Reference: ${reference}`)

      // Update payment as failed due to amount mismatch
      await supabase
        .from("wallet_payments")
        .update({
          status: "failed",
          amount_received: paidAmount,
          failure_reason: `Amount mismatch: paid ${paidAmount}, expected ${expectedAmount}`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", paymentData.id)

      // If there's an order, mark it as failed too
      if (paymentData.order_id) {
        const table = paymentData.order_type === "airtime" ? "airtime_orders" : "shop_orders"
        const updateData: any = {
          payment_status: "failed",
          updated_at: new Date().toISOString(),
        }
        
        if (paymentData.order_type === "airtime") {
          updateData.status = "failed"
        } else {
          updateData.order_status = "failed"
        }

        await supabase
          .from(table)
          .update(updateData)
          .eq("id", paymentData.order_id)
      }

      return NextResponse.json(
        { error: "Payment amount mismatch - payment rejected", success: false },
        { status: 400 }
      )
    }

    console.log(`[PAYMENT-VERIFY] ✓ Payment amount verified: ${paidAmount} GHS`)

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

    // Credit wallet / trigger fulfillment if Paystack confirms success
    if (verificationResult.status === "success") {

      // Skip wallet credit for dealer upgrades - the webhook handles those
      if (paymentData.order_type === "dealer_upgrade") {
        console.log("[PAYMENT-VERIFY] ℹ Dealer upgrade payment - skipping wallet credit (handled by webhook)")
      } else {
        console.log("[PAYMENT-VERIFY] Paystack confirmed success. Triggering completion via admin endpoint...")

        // Call the admin PATCH endpoint which handles all completion logic:
        // wallet credit, fulfillment, notifications, balance sync, etc.
        try {
          // FIX: correct operator precedence — NEXT_PUBLIC_APP_URL is checked first,
          // then VERCEL_URL (prefixed with https://), then localhost as fallback.
          const baseUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000")

          const completionResponse = await fetch(`${baseUrl}/api/admin/payment-attempts`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              "x-internal-secret": process.env.INTERNAL_API_SECRET || "",
            },
            body: JSON.stringify({ reference, status: "completed" }),
          })

          const completionResult = await completionResponse.json()

          if (!completionResponse.ok) {
            // If already completed, that's fine - not an error for the user
            if (completionResult.error?.includes("already marked as completed")) {
              console.log("[PAYMENT-VERIFY] Payment already completed")
            } else {
              console.error("[PAYMENT-VERIFY] Completion endpoint error:", completionResult)
            }
          } else {
            console.log("[PAYMENT-VERIFY] ✓ Payment completed successfully via admin endpoint")
          }
        } catch (completionError) {
          console.error("[PAYMENT-VERIFY] Error calling completion endpoint:", completionError)
        }
      }

      // If payment was for a shop order, update its payment status and create profit record
      if (paymentData.order_id) {
        console.log(`[PAYMENT-VERIFY] Payment is for ${paymentData.order_type || 'shop'} order (${paymentData.order_id}). Updating order payment status...`)

        if (paymentData.order_type === "airtime") {
          // 1. Handle Airtime Orders
          const { data: airtimeData, error: airtimeFetchError } = await supabase
            .from("airtime_orders")
            .select("id, shop_id, merchant_commission, reference_code, network, airtime_amount, beneficiary_phone, notes, status, is_flagged")
            .eq("id", paymentData.order_id)
            .maybeSingle()

          if (!airtimeFetchError && airtimeData) {
            // 0. Fraud Check
            const isBlacklisted = await isPhoneBlacklisted(airtimeData.beneficiary_phone)
            
            if (isBlacklisted) {
              console.warn(`[PAYMENT-VERIFY] ⚠️ FRAUD ALERT: Beneficiary ${airtimeData.beneficiary_phone} is blacklisted. Skipping profit disbursement.`)
              
              // Update order with fraud note
              await supabase
                .from("airtime_orders")
                .update({
                  payment_status: "completed",
                  status: "flagged",
                  is_flagged: true,
                  notes: (airtimeData.notes || "") + "[FLAGGED: Beneficiary Blacklisted]",
                  transaction_id: verificationResult.transaction_id,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", airtimeData.id)
              
              console.log(`[PAYMENT-VERIFY] ✓ Airtime order flagged/completed.`)
            } else {
              // Update Airtime Order (Normal flow)
              await supabase
                .from("airtime_orders")
                .update({
                  payment_status: "completed",
                  status: "pending",
                  transaction_id: verificationResult.transaction_id,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", airtimeData.id)
              
              console.log(`[PAYMENT-VERIFY] ✓ Airtime order status updated to pending`)

              // Create profit record for merchant — balance is auto-synced by DB trigger
              const commission = airtimeData.merchant_commission || 0
              const shopId = airtimeData.shop_id || paymentData.shop_id
              if (commission > 0 && shopId) {
                const { error: airtimeProfitError } = await supabase
                  .from("shop_profits")
                  .insert([{
                    shop_id: shopId,
                    airtime_order_id: airtimeData.id,
                    profit_amount: commission,
                    status: "credited",
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                  }])
                if (airtimeProfitError && airtimeProfitError.code !== "23505") {
                  console.error(`[PAYMENT-VERIFY] Failed to insert airtime profit:`, airtimeProfitError)
                } else {
                  console.log(`[PAYMENT-VERIFY] ✓ Airtime profit recorded: GHS ${commission} for shop ${shopId} (balance synced by DB trigger)`)
                }
              }
            }

            // Send SMS to beneficiary and admin
            try {
              const { data: shopData } = airtimeData.shop_id 
                ? await supabase.from("user_shops").select("shop_name").eq("id", airtimeData.shop_id).single()
                : { data: null }
              
              const shopName = shopData?.shop_name || "Direct"
              const beneficiarySms = SMSTemplates.airtimeBeneficiaryNotification(
                shopName,
                airtimeData.network,
                airtimeData.airtime_amount.toString(),
                airtimeData.beneficiary_phone,
                airtimeData.reference_code
              )

              await sendSMS({
                phone: airtimeData.beneficiary_phone,
                message: beneficiarySms,
                type: 'airtime_payment_confirmed',
                reference: airtimeData.id,
              }).catch(err => console.error("[PAYMENT-VERIFY] Airtime Beneficiary SMS error:", err))

              const adminSms = SMSTemplates.adminAirtimeOrderNotification(
                shopName,
                airtimeData.beneficiary_phone,
                airtimeData.airtime_amount.toString(),
                airtimeData.network
              )

              const { notifyAdmins } = await import("@/lib/sms-service")
              const alertPrefix = isBlacklisted ? "[FRAUD-ALERT] " : ""
              await notifyAdmins(
                alertPrefix + adminSms,
                isBlacklisted ? "airtime_fraud_alert" : "airtime_new_order",
                airtimeData.id
              )
            } catch (smsError) {
              console.warn("[PAYMENT-VERIFY] Airtime SMS notification failed:", smsError)
            }
          }
        } else {
          // 2. Handle Shop Orders (Data)
          const { data: shopOrderData, error: shopOrderFetchError } = await supabase
            .from("shop_orders")
            .select("id, shop_id, profit_amount, network, volume_gb, customer_phone, customer_name")
            .eq("id", paymentData.order_id)
            .single()

          if (!shopOrderFetchError && shopOrderData) {
            // Update Data Order
            await supabase
              .from("shop_orders")
              .update({
                payment_status: "completed",
                updated_at: new Date().toISOString(),
              })
              .eq("id", shopOrderData.id)

            console.log("[PAYMENT-VERIFY] ✓ Shop DATA order payment status updated to completed")

            // Create profit record — balance is auto-synced by DB trigger
            const profitAmount = shopOrderData.profit_amount || 0
            const shopId = shopOrderData.shop_id || paymentData.shop_id
            
            if (profitAmount > 0 && shopId) {
              const { error: dataProfitError } = await supabase
                .from("shop_profits")
                .insert([{
                  shop_id: shopId,
                  shop_order_id: shopOrderData.id,
                  profit_amount: profitAmount,
                  status: "credited",
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                }])
              if (dataProfitError && dataProfitError.code !== "23505") {
                console.error(`[PAYMENT-VERIFY] Failed to insert data order profit:`, dataProfitError)
              } else {
                console.log(`[PAYMENT-VERIFY] ✓ Data order profit recorded: GHS ${profitAmount} for shop ${shopId} (balance synced by DB trigger)`)
              }
            }

            // Trigger fulfillment logic for data
            if (shopOrderData.customer_phone) {
              console.log(`[PAYMENT-VERIFY] Triggering unified fulfillment for order ${shopOrderData.id}`)
              try {
                const sizeGb = parseInt(shopOrderData.volume_gb?.toString().replace(/[^0-9]/g, "") || "0") || 0
                const baseUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000")
                await fetch(`${baseUrl}/api/fulfillment/process-order`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    shop_order_id: shopOrderData.id,
                    network: shopOrderData.network,
                    phone_number: shopOrderData.customer_phone,
                    volume_gb: sizeGb,
                    customer_name: shopOrderData.customer_name,
                  }),
                })
              } catch (fError) {
                console.error("[PAYMENT-VERIFY] Fulfillment trigger error:", fError)
              }

              // Blacklist check
              try {
                const isBlacklisted = await isPhoneBlacklisted(shopOrderData.customer_phone)
                if (isBlacklisted) {
                  await sendSMS({
                    phone: shopOrderData.customer_phone,
                    message: `DATAGOD: Your payment has been confirmed for ${shopOrderData.network} ${shopOrderData.volume_gb}GB to ${shopOrderData.customer_phone}. However, this number is blacklisted and your order will not be fulfilled. Contact support for assistance.`,
                    type: 'order_blacklisted',
                    reference: shopOrderData.id,
                  })
                }
              } catch (bError) {
                console.warn("[PAYMENT-VERIFY] Blacklist error:", bError)
              }
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
