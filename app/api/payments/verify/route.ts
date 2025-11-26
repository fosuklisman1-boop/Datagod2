import { NextRequest, NextResponse } from "next/server"
import { verifyPayment } from "@/lib/paystack"
import { createClient } from "@supabase/supabase-js"

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

    // Fetch payment record
    console.log("[PAYMENT-VERIFY] Fetching payment record...")
    const { data: paymentData, error: fetchError } = await supabase
      .from("wallet_payments")
      .select("*")
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
      console.log("[PAYMENT-VERIFY] Crediting wallet...")
      const amount = parseFloat(verificationResult.amount.toString())

      const { data: wallet } = await supabase
        .from("user_wallets")
        .select("*")
        .eq("user_id", paymentData.user_id)
        .maybeSingle()

      if (!wallet) {
        await supabase.from("user_wallets").insert([{
          user_id: paymentData.user_id,
          balance: amount,
          total_credited: amount,
          total_debited: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }])
      } else {
        await supabase
          .from("user_wallets")
          .update({
            balance: (wallet.balance || 0) + amount,
            total_credited: (wallet.total_credited || 0) + amount,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", paymentData.user_id)
      }

      // Create transaction
      await supabase.from("wallet_transactions").insert([{
        user_id: paymentData.user_id,
        type: "credit",
        amount,
        reference,
        description: "Wallet top-up via Paystack",
        status: "completed",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }])

      console.log("[PAYMENT-VERIFY] ✓ Wallet credited:", amount)
    }

    console.log("[PAYMENT-VERIFY] ✓ Complete")

    return NextResponse.json({
      success: true,
      status: verificationResult.status,
      amount: verificationResult.amount,
      reference: verificationResult.reference,
      message:
        verificationResult.status === "success"
          ? "Payment successful! Wallet credited."
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
