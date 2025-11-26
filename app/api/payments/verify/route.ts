import { NextRequest, NextResponse } from "next/server"
import { verifyPayment } from "@/lib/paystack"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  try {
    const { reference } = await request.json()

    console.log("=== PAYMENT VERIFICATION ===")
    console.log("Reference:", reference)

    if (!reference) {
      return NextResponse.json(
        { error: "Payment reference is required" },
        { status: 400 }
      )
    }

    // Verify payment with Paystack
    console.log("Calling Paystack verification...")
    const verificationResult = await verifyPayment(reference)
    console.log("Verification result:", {
      status: verificationResult.status,
      amount: verificationResult.amount,
      amountType: typeof verificationResult.amount,
    })

    // Update payment record in database
    const { data: paymentData, error: fetchError } = await supabase
      .from("wallet_payments")
      .select("*")
      .eq("reference", reference)
      .single()

    if (fetchError) {
      console.error("Error fetching payment record:", fetchError)
      return NextResponse.json(
        { error: "Payment record not found" },
        { status: 404 }
      )
    }

    console.log("Payment record found:", {
      id: paymentData.id,
      originalAmount: paymentData.amount,
      status: paymentData.status,
    })

    // Update payment status
    const paymentStatus =
      verificationResult.status === "success" ? "completed" : verificationResult.status

    const { error: updateError } = await supabase
      .from("wallet_payments")
      .update({
        status: paymentStatus,
        amount_received: verificationResult.amount,
        updated_at: new Date().toISOString(),
      })
      .eq("id", paymentData.id)

    if (updateError) {
      throw new Error(`Failed to update payment: ${updateError.message}`)
    }

    console.log("Payment status updated to:", paymentStatus)

    // If payment was successful, credit the wallet
    if (verificationResult.status === "success") {
      console.log("Creating wallet transaction for user:", paymentData.user_id)
      console.log("Amount to credit (GHS):", verificationResult.amount)

      const { error: walletError } = await supabase
        .from("user_wallets")
        .update({
          balance: supabase.rpc("increment_balance", {
            user_id: paymentData.user_id,
            amount: verificationResult.amount,
          }),
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", paymentData.user_id)

      // Create wallet transaction record
      const { error: transactionError } = await supabase
        .from("wallet_transactions")
        .insert([
          {
            user_id: paymentData.user_id,
            type: "credit",
            amount: verificationResult.amount,
            reference: reference,
            description: "Wallet top-up via Paystack",
            status: "completed",
            created_at: new Date().toISOString(),
          },
        ])

      if (transactionError) {
        console.warn("⚠ Warning: Failed to create transaction record:", transactionError)
      } else {
        console.log("✓ Wallet transaction created successfully")
      }
    }

    console.log("✓ Verification completed successfully")

    return NextResponse.json({
      success: true,
      status: verificationResult.status,
      amount: verificationResult.amount,
      reference: verificationResult.reference,
      message:
        verificationResult.status === "success"
          ? "Payment successful! Wallet has been credited."
          : `Payment status: ${verificationResult.status}`,
    })
  } catch (error) {
    console.error("❌ Error verifying payment:", error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to verify payment",
      },
      { status: 500 }
    )
  }
}
