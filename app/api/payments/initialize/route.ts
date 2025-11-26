import { NextRequest, NextResponse } from "next/server"
import { initializePayment } from "@/lib/paystack"
import { createClient } from "@supabase/supabase-js"
import crypto from "crypto"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  try {
    const { amount, email, userId, shopId } = await request.json()

    // Log incoming request
    console.log("=== PAYMENT INITIALIZATION ===")
    console.log("Incoming request:", { amount, email, userId, shopId })
    console.log("PAYSTACK_CURRENCY env:", process.env.PAYSTACK_CURRENCY)

    // Validate input
    if (!amount || !email || !userId) {
      return NextResponse.json(
        { error: "Missing required fields: amount, email, userId" },
        { status: 400 }
      )
    }

    if (amount <= 0) {
      return NextResponse.json(
        { error: "Amount must be greater than 0" },
        { status: 400 }
      )
    }

    // Generate unique reference
    const reference = `WALLET-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`

    // Store payment record in database
    const { data: paymentData, error: paymentError } = await supabase
      .from("wallet_payments")
      .insert([
        {
          user_id: userId,
          shop_id: shopId || null,
          amount,
          reference,
          status: "pending",
          payment_method: "paystack",
          created_at: new Date().toISOString(),
        },
      ])
      .select()

    if (paymentError) {
      throw new Error(`Failed to create payment record: ${paymentError.message}`)
    }

    console.log("DB: Stored amount (GHS):", amount)

    // Initialize Paystack payment
    console.log("Sending to Paystack with amount (GHS):", amount, "→ kobo:", amount * 100)
    const paymentResult = await initializePayment({
      email,
      amount,
      reference,
      metadata: {
        userId,
        shopId: shopId || null,
        type: "wallet_topup",
      },
    })

    console.log("Paystack response:", {
      authorizationUrl: paymentResult.authorizationUrl ? "✓" : "✗",
      accessCode: paymentResult.accessCode,
      reference: paymentResult.reference,
    })

    return NextResponse.json({
      success: true,
      authorizationUrl: paymentResult.authorizationUrl,
      accessCode: paymentResult.accessCode,
      reference: paymentResult.reference,
      paymentId: paymentData[0].id,
    })
  } catch (error) {
    console.error("❌ ERROR initializing payment:", error)
    const errorMessage = error instanceof Error ? error.message : "Failed to initialize payment"
    return NextResponse.json(
      {
        error: errorMessage,
        details: error instanceof Error ? error.toString() : "Unknown error",
      },
      { status: 500 }
    )
  }
}
