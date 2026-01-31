import { NextRequest, NextResponse } from "next/server"
import { initializePayment } from "@/lib/paystack"
import { createClient } from "@supabase/supabase-js"
import crypto from "crypto"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { amount, email, userId, shopId, orderId, shopSlug, type, planId } = body

    console.log("[PAYMENT-INIT] Request received:")
    console.log("  User:", userId)
    console.log("  Email:", email)
    console.log("  Amount:", amount)
    console.log("  Shop ID:", shopId)
    console.log("  Order ID:", orderId)

    // Validate input
    if (!email) {
      console.warn("[PAYMENT-INIT] Missing required fields")
      return NextResponse.json(
        { error: "Missing required fields: email" },
        { status: 400 }
      )
    }

    let finalAmount = amount

    // SECURITY ENHANCEMENT: For shop orders, ignore client amount & fetch from DB
    if (orderId) {
      console.log(`[PAYMENT-INIT] Shop Order detected (${orderId}). Verifying price from database...`)

      const { data: orderData, error: orderError } = await supabase
        .from("shop_orders")
        .select("total_price")
        .eq("id", orderId)
        .single()

      if (orderError || !orderData) {
        console.error("[PAYMENT-INIT] ❌ Could not find order:", orderError)
        return NextResponse.json(
          { error: "Invalid order ID" },
          { status: 400 }
        )
      }

      // Override client amount with server-verified amount
      // Ensure we treat it as a number
      const verifiedAmount = Number(orderData.total_price)

      if (isNaN(verifiedAmount) || verifiedAmount <= 0) {
        console.error("[PAYMENT-INIT] ❌ Invalid order price in DB:", orderData.total_price)
        return NextResponse.json(
          { error: "Invalid order configuration" },
          { status: 500 }
        )
      }

      console.log(`[PAYMENT-INIT] ✓ Price verified. Client sent: ${amount}, DB has: ${verifiedAmount}. Enforcing DB value.`)
      finalAmount = verifiedAmount
    } else if (type === "dealer_upgrade" && planId) {
      console.log(`[PAYMENT-INIT] Dealer Upgrade detected. Verifying plan ${planId}...`)
      const { data: plan, error: planError } = await supabase
        .from("subscription_plans")
        .select("price")
        .eq("id", planId)
        .eq("is_active", true)
        .single()

      if (planError || !plan) {
        console.error("[PAYMENT-INIT] ❌ Could not find active plan:", planError)
        return NextResponse.json({ error: "Invalid subscription plan" }, { status: 400 })
      }

      finalAmount = Number(plan.price)
      console.log(`[PAYMENT-INIT] ✓ Plan price verified: ${finalAmount}`)
    } else {
      // For Wallet Top-up (no orderId), we require amount
      if (!amount || typeof amount !== "number" || amount <= 0) {
        console.warn("[PAYMENT-INIT] Invalid amount for top-up:", amount)
        return NextResponse.json(
          { error: "Amount must be a positive number" },
          { status: 400 }
        )
      }
    }

    // Use finalAmount for all subsequent calculations
    const processingAmount = finalAmount
    const amountToUse = processingAmount; // Alias to minimize diff changes below if 'amount' var is reused elsewhere, but we should replace 'amount' usages with 'finalAmount'


    // Generate unique reference
    const reference = `WALLET-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`

    // Get current fee settings from app_settings
    const { data: settings, error: settingsError } = await supabase
      .from("app_settings")
      .select("paystack_fee_percentage")
      .single()

    const paystackFeePercentage = (settings?.paystack_fee_percentage || 3.0) / 100
    // Use finalAmount (verified) for calculation
    const paystackFee = Math.round(finalAmount * paystackFeePercentage * 100) / 100
    const totalAmount = finalAmount + paystackFee

    console.log("[PAYMENT-INIT] Fee Calculation:")
    console.log("  Original Amount:", finalAmount)
    console.log(`  Paystack Fee (${paystackFeePercentage * 100}%):`, paystackFee)
    console.log("  Total Amount:", totalAmount)

    // Store payment record with total amount (including fee)
    console.log("[PAYMENT-INIT] Creating payment record...")
    const { data: paymentData, error: paymentError } = await supabase
      .from("wallet_payments")
      .insert([
        {
          user_id: userId,
          shop_id: shopId || null,
          order_id: orderId || null,
          amount: parseFloat(totalAmount.toString()),
          fee: parseFloat(paystackFee.toString()),
          reference,
          status: "pending",
          payment_method: "paystack",
          created_at: new Date().toISOString(),
        },
      ])
      .select()

    if (paymentError || !paymentData || paymentData.length === 0) {
      console.error("[PAYMENT-INIT] Database error:", paymentError)
      console.error("[PAYMENT-INIT] Error code:", paymentError?.code)
      console.error("[PAYMENT-INIT] Error message:", paymentError?.message)
      console.error("[PAYMENT-INIT] Error details:", JSON.stringify(paymentError, null, 2))
      throw new Error(`Failed to create payment record: ${paymentError?.message || "Unknown error"}`)
    }

    console.log("[PAYMENT-INIT] ✓ Payment record created:", paymentData[0].id)

    // Initialize Paystack with redirect URL
    console.log("[PAYMENT-INIT] Calling Paystack...")
    // For shop orders, redirect to order confirmation; for wallet topup, redirect to wallet page with reference
    const redirectUrl = shopId && orderId && shopSlug
      ? `${request.headers.get("origin") || "http://localhost:3000"}/shop/${shopSlug}/order-confirmation/${orderId}?reference=${reference}`
      : `${request.headers.get("origin") || "http://localhost:3000"}/dashboard/wallet?reference=${reference}`
    console.log("[PAYMENT-INIT] Redirect URL:", redirectUrl)

    const paymentResult = await initializePayment({
      email,
      amount: totalAmount,
      reference,
      redirectUrl,
      metadata: {
        userId,
        shopId: shopId || null,
        type: type || "wallet_topup",
        planId: planId || null,
        originalAmount: finalAmount,
        paystackFee: paystackFee,
      },
      channels: ["card", "mobile_money", "bank_transfer"],
    })

    console.log("[PAYMENT-INIT] ✓ Success")

    // Track payment attempt in payment_attempts table (non-blocking)
    supabase
      .from("payment_attempts")
      .insert([{
        user_id: userId,
        reference,
        amount: finalAmount,
        fee: paystackFee,
        email,
        status: "pending",
        payment_type: shopId ? "shop_order" : "wallet_topup",
        shop_id: shopId || null,
        order_id: orderId || null,
        created_at: new Date().toISOString(),
      }])
      .then(({ error }) => {
        if (error) {
          console.warn("[PAYMENT-INIT] Failed to create payment attempt record:", error.message)
        } else {
          console.log("[PAYMENT-INIT] ✓ Payment attempt tracked")
        }
      })

    // Add Safari-compatible CORS headers
    const response = NextResponse.json({
      success: true,
      authorizationUrl: paymentResult.authorizationUrl,
      accessCode: paymentResult.accessCode,
      reference: paymentResult.reference,
      paymentId: paymentData[0].id,
    })

    // Safari-compatible headers
    response.headers.set("Access-Control-Allow-Origin", request.headers.get("origin") || "*")
    response.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS")
    response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization")
    response.headers.set("Access-Control-Allow-Credentials", "true")
    response.headers.set("Cache-Control", "no-cache, no-store, must-revalidate")
    response.headers.set("Pragma", "no-cache")
    response.headers.set("Expires", "0")

    return response
  } catch (error) {
    console.error("[PAYMENT-INIT] ✗ Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to initialize payment" },
      { status: 500 }
    )
  }
}
