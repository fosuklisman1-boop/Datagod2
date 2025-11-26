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

      // Credit the wallet
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
