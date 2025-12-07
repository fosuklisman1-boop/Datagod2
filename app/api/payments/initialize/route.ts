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
    const { amount, email, userId, shopId, orderId, shopSlug } = body

    console.log("[PAYMENT-INIT] Request received:")
    console.log("  User:", userId)
    console.log("  Email:", email)
    console.log("  Amount:", amount)
    console.log("  Shop ID:", shopId)
    console.log("  Order ID:", orderId)

    // Validate input
    if (!amount || !email || !userId) {
      console.warn("[PAYMENT-INIT] Missing required fields")
      return NextResponse.json(
        { error: "Missing required fields: amount, email, userId" },
        { status: 400 }
      )
    }

    if (typeof amount !== "number" || amount <= 0) {
      console.warn("[PAYMENT-INIT] Invalid amount:", amount)
      return NextResponse.json(
        { error: "Amount must be a positive number" },
        { status: 400 }
      )
    }

    // Generate unique reference with more entropy to prevent duplicates
    const timestamp = Date.now()
    const randomPart = crypto.randomBytes(8).toString("hex").toUpperCase()
    const reference = `WALLET-${timestamp}-${randomPart}`

    // Calculate 3% Paystack fee
    const paystackFeePercentage = 0.03
    const paystackFee = Math.round(amount * paystackFeePercentage * 100) / 100
    const totalAmount = amount + paystackFee

    console.log("[PAYMENT-INIT] Fee Calculation:")
    console.log("  Original Amount:", amount)
    console.log("  Paystack Fee (3%):", paystackFee)
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
    // For shop orders, redirect to order confirmation; for wallet topup, redirect to wallet page
    const redirectUrl = shopId && orderId && shopSlug
      ? `${request.headers.get("origin") || "http://localhost:3000"}/shop/${shopSlug}/order-confirmation/${orderId}`
      : `${request.headers.get("origin") || "http://localhost:3000"}/dashboard/wallet?payment_status=completed`
    console.log("[PAYMENT-INIT] Redirect URL:", redirectUrl)
    
    const paymentResult = await initializePayment({
      email,
      amount: totalAmount,
      reference,
      redirectUrl,
      metadata: {
        userId,
        shopId: shopId || null,
        type: "wallet_topup",
        originalAmount: amount,
        paystackFee: paystackFee,
      },
      channels: ["card", "mobile_money", "bank_transfer"],
    })

    console.log("[PAYMENT-INIT] ✓ Success")

    return NextResponse.json({
      success: true,
      authorizationUrl: paymentResult.authorizationUrl,
      accessCode: paymentResult.accessCode,
      reference: paymentResult.reference,
      paymentId: paymentData[0].id,
    })
  } catch (error) {
    console.error("[PAYMENT-INIT] ✗ Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to initialize payment" },
      { status: 500 }
    )
  }
}
