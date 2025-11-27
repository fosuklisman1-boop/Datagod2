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
      console.log("[PAYMENT-VERIFY] Amount to credit:", amount)

      const { data: wallet, error: walletFetchError } = await supabase
        .from("user_wallets")
        .select("*")
        .eq("user_id", paymentData.user_id)
        .maybeSingle()

      if (walletFetchError) {
        console.error("[PAYMENT-VERIFY] Wallet fetch error:", walletFetchError)
        throw new Error("Failed to fetch wallet")
      }

      if (!wallet) {
        console.log("[PAYMENT-VERIFY] Creating new wallet...")
        const { error: insertError } = await supabase.from("user_wallets").insert([{
          user_id: paymentData.user_id,
          balance: amount,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }])
        if (insertError) {
          console.error("[PAYMENT-VERIFY] Wallet creation error:", insertError)
          throw new Error("Failed to create wallet")
        }
        console.log("[PAYMENT-VERIFY] ✓ New wallet created with balance:", amount)
      } else {
        console.log("[PAYMENT-VERIFY] Updating existing wallet. Current balance:", wallet.balance, "Adding:", amount)
        const newBalance = (wallet.balance || 0) + amount
        console.log("[PAYMENT-VERIFY] New balance will be:", newBalance)
        
        const { error: updateError } = await supabase
          .from("user_wallets")
          .update({
            balance: newBalance,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", paymentData.user_id)
        
        if (updateError) {
          console.error("[PAYMENT-VERIFY] Wallet update error:", updateError)
          throw new Error("Failed to update wallet balance")
        }
        console.log("[PAYMENT-VERIFY] ✓ Wallet updated")
      }

      // Create transaction
      console.log("[PAYMENT-VERIFY] Creating transaction record...")
      const { error: txError } = await supabase.from("wallet_transactions").insert([{
        user_id: paymentData.user_id,
        type: "credit",
        amount,
        reference,
        description: "Wallet top-up via Paystack",
        status: "completed",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }])
      
      if (txError) {
        console.error("[PAYMENT-VERIFY] Transaction creation error:", txError)
        throw new Error("Failed to create transaction")
      }

      console.log("[PAYMENT-VERIFY] ✓ Wallet credited:", amount)

      // If payment was for a shop order, update its payment status and create profit record
      if (paymentData.shop_id && paymentData.order_id) {
        console.log("[PAYMENT-VERIFY] Payment is for shop order. Updating shop order payment status...")
        
        // Find shop order by order_id from payment record
        const { data: shopOrderData, error: shopOrderFetchError } = await supabase
          .from("shop_orders")
          .select("*")
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
