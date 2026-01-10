/**
 * Payment Cleanup Service
 * Handles cleanup of abandoned payments and verification of pending payments
 */

import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Only create client if we have the required env vars (for server-side use)
const getSupabaseAdmin = () => {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase environment variables")
  }
  return createClient(supabaseUrl, serviceRoleKey)
}

const PAYSTACK_BASE_URL = "https://api.paystack.co"
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY

/**
 * Verify a payment status directly with Paystack API
 */
async function verifyWithPaystack(reference: string): Promise<{
  status: "success" | "failed" | "abandoned" | "pending"
  gatewayResponse?: string
  amount?: number
}> {
  try {
    const response = await fetch(
      `${PAYSTACK_BASE_URL}/transaction/verify/${reference}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        },
      }
    )

    const data = await response.json()

    if (!response.ok) {
      // If Paystack returns 404 or error, payment was never completed
      if (response.status === 404 || data.message?.includes("not found")) {
        return { status: "abandoned" }
      }
      return { status: "pending" }
    }

    if (!data.status || !data.data) {
      return { status: "abandoned" }
    }

    const transaction = data.data
    
    if (transaction.status === "success") {
      return { 
        status: "success", 
        amount: transaction.amount / 100,
        gatewayResponse: transaction.gateway_response 
      }
    } else if (transaction.status === "failed") {
      return { 
        status: "failed", 
        gatewayResponse: transaction.gateway_response 
      }
    } else {
      return { status: "pending" }
    }
  } catch (error) {
    console.error("[PAYMENT-CLEANUP] Error verifying with Paystack:", error)
    return { status: "pending" }
  }
}

/**
 * Clean up abandoned payments older than specified minutes
 * Marks them as "abandoned" status
 */
export async function cleanupAbandonedPayments(
  olderThanMinutes: number = 30
): Promise<{ cleaned: number; verified: number; credited: number }> {
  const supabase = getSupabaseAdmin()
  
  const cutoffTime = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString()
  
  console.log(`[PAYMENT-CLEANUP] Looking for pending payments older than ${olderThanMinutes} minutes...`)

  // Find pending wallet payments older than cutoff
  const { data: pendingPayments, error } = await supabase
    .from("wallet_payments")
    .select("id, reference, user_id, amount, created_at, shop_id, order_id")
    .eq("status", "pending")
    .lt("created_at", cutoffTime)
    .limit(100) // Process in batches

  if (error) {
    console.error("[PAYMENT-CLEANUP] Error fetching pending payments:", error)
    throw error
  }

  if (!pendingPayments || pendingPayments.length === 0) {
    console.log("[PAYMENT-CLEANUP] No abandoned payments found")
    return { cleaned: 0, verified: 0, credited: 0 }
  }

  console.log(`[PAYMENT-CLEANUP] Found ${pendingPayments.length} pending payments to check`)

  let cleaned = 0
  let verified = 0
  let credited = 0

  for (const payment of pendingPayments) {
    try {
      // Verify with Paystack first
      const paystackStatus = await verifyWithPaystack(payment.reference)
      
      if (paystackStatus.status === "success") {
        // Payment was actually successful! Credit the wallet
        console.log(`[PAYMENT-CLEANUP] Payment ${payment.reference} was successful - crediting wallet`)
        
        // Check if transaction already exists (prevent double credit)
        const { data: existingTransaction } = await supabase
          .from("transactions")
          .select("id")
          .eq("reference_id", payment.reference)
          .eq("user_id", payment.user_id)
          .eq("type", "credit")
          .maybeSingle()

        if (existingTransaction) {
          console.log(`[PAYMENT-CLEANUP] ✓ Reference ${payment.reference} already credited. Skipping duplicate credit.`)
          // Still mark payment as completed if not already
          await supabase
            .from("wallet_payments")
            .update({ status: "completed", updated_at: new Date().toISOString() })
            .eq("id", payment.id)
          verified++
          continue
        }

        // Get current wallet balance
        const { data: wallet } = await supabase
          .from("wallets")
          .select("balance, total_credited")
          .eq("user_id", payment.user_id)
          .single()

        const currentBalance = wallet?.balance || 0
        const currentTotalCredited = wallet?.total_credited || 0
        const creditAmount = paystackStatus.amount || payment.amount
        const newBalance = currentBalance + creditAmount

        // Update wallet
        await supabase
          .from("wallets")
          .upsert({
            user_id: payment.user_id,
            balance: newBalance,
            total_credited: currentTotalCredited + creditAmount,
            updated_at: new Date().toISOString(),
          }, { onConflict: "user_id" })

        // Update payment status
        await supabase
          .from("wallet_payments")
          .update({ status: "completed", updated_at: new Date().toISOString() })
          .eq("id", payment.id)

        // Create transaction record
        await supabase
          .from("transactions")
          .insert([{
            user_id: payment.user_id,
            type: "credit",
            amount: creditAmount,
            reference_id: payment.reference,
            source: "wallet_topup",
            description: "Wallet top-up via Paystack (recovered)",
            status: "completed",
            balance_before: currentBalance,
            balance_after: newBalance,
            created_at: new Date().toISOString(),
          }])

        // Notify user
        await supabase
          .from("notifications")
          .insert([{
            user_id: payment.user_id,
            title: "Wallet Credited",
            message: `Your wallet has been credited with GHS ${creditAmount.toFixed(2)}. This payment was recovered from a pending transaction.`,
            type: "balance_updated",
            is_read: false,
            created_at: new Date().toISOString(),
          }])

        credited++
        verified++
      } else if (paystackStatus.status === "failed") {
        // Payment failed - mark as failed
        console.log(`[PAYMENT-CLEANUP] Payment ${payment.reference} failed - ${paystackStatus.gatewayResponse}`)
        
        await supabase
          .from("wallet_payments")
          .update({ status: "failed", updated_at: new Date().toISOString() })
          .eq("id", payment.id)

        // Create failed transaction record for tracking
        if (!payment.shop_id) {
          await supabase
            .from("transactions")
            .insert([{
              user_id: payment.user_id,
              type: "credit",
              amount: payment.amount,
              reference_id: payment.reference,
              source: "wallet_topup",
              description: `Failed wallet top-up: ${paystackStatus.gatewayResponse || "Payment declined"}`,
              status: "failed",
              created_at: new Date().toISOString(),
            }])
        }

        cleaned++
        verified++
      } else if (paystackStatus.status === "abandoned") {
        // Payment was never completed - mark as abandoned
        console.log(`[PAYMENT-CLEANUP] Payment ${payment.reference} abandoned - marking as abandoned`)
        
        await supabase
          .from("wallet_payments")
          .update({ status: "abandoned", updated_at: new Date().toISOString() })
          .eq("id", payment.id)

        // Update shop order if applicable
        if (payment.shop_id && payment.order_id) {
          await supabase
            .from("shop_orders")
            .update({ 
              payment_status: "abandoned",
              updated_at: new Date().toISOString() 
            })
            .eq("id", payment.order_id)
        }

        cleaned++
      }
      // If still pending, leave it alone (might still complete)
      
    } catch (error) {
      console.error(`[PAYMENT-CLEANUP] Error processing payment ${payment.reference}:`, error)
    }
  }

  console.log(`[PAYMENT-CLEANUP] Complete: ${cleaned} cleaned, ${verified} verified, ${credited} credited`)
  return { cleaned, verified, credited }
}

/**
 * Verify pending payments for a specific user
 * Call this when user loads wallet page
 */
export async function verifyUserPendingPayments(userId: string): Promise<{
  checked: number
  credited: number
  failed: number
}> {
  const supabase = getSupabaseAdmin()
  
  // Find pending payments for this user (last 24 hours only)
  const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  
  const { data: pendingPayments, error } = await supabase
    .from("wallet_payments")
    .select("id, reference, amount, shop_id")
    .eq("user_id", userId)
    .eq("status", "pending")
    .gt("created_at", cutoffTime)
    .is("shop_id", null) // Only wallet top-ups, not shop orders

  if (error || !pendingPayments || pendingPayments.length === 0) {
    return { checked: 0, credited: 0, failed: 0 }
  }

  console.log(`[PAYMENT-VERIFY] Checking ${pendingPayments.length} pending payments for user ${userId}`)

  let checked = 0
  let credited = 0
  let failed = 0

  for (const payment of pendingPayments) {
    try {
      const paystackStatus = await verifyWithPaystack(payment.reference)
      checked++

      if (paystackStatus.status === "success") {
        // Check if transaction already exists (prevent double credit)
        const { data: existingTransaction } = await supabase
          .from("transactions")
          .select("id")
          .eq("reference_id", payment.reference)
          .eq("user_id", userId)
          .eq("type", "credit")
          .maybeSingle()

        if (existingTransaction) {
          console.log(`[PAYMENT-VERIFY] ✓ Reference ${payment.reference} already credited. Skipping duplicate credit.`)
          // Still mark payment as completed if not already
          await supabase
            .from("wallet_payments")
            .update({ status: "completed", updated_at: new Date().toISOString() })
            .eq("id", payment.id)
          continue
        }

        // Get current wallet
        const { data: wallet } = await supabase
          .from("wallets")
          .select("balance, total_credited")
          .eq("user_id", userId)
          .single()

        const currentBalance = wallet?.balance || 0
        const creditAmount = paystackStatus.amount || payment.amount
        const newBalance = currentBalance + creditAmount

        // Update wallet
        await supabase
          .from("wallets")
          .upsert({
            user_id: userId,
            balance: newBalance,
            total_credited: (wallet?.total_credited || 0) + creditAmount,
            updated_at: new Date().toISOString(),
          }, { onConflict: "user_id" })

        // Update payment status
        await supabase
          .from("wallet_payments")
          .update({ status: "completed", updated_at: new Date().toISOString() })
          .eq("id", payment.id)

        // Create transaction record
        await supabase
          .from("transactions")
          .insert([{
            user_id: userId,
            type: "credit",
            amount: creditAmount,
            reference_id: payment.reference,
            source: "wallet_topup",
            description: "Wallet top-up via Paystack (verified)",
            status: "completed",
            balance_before: currentBalance,
            balance_after: newBalance,
            created_at: new Date().toISOString(),
          }])

        credited++
        console.log(`[PAYMENT-VERIFY] ✓ Payment ${payment.reference} verified and credited`)
      } else if (paystackStatus.status === "failed") {
        await supabase
          .from("wallet_payments")
          .update({ status: "failed", updated_at: new Date().toISOString() })
          .eq("id", payment.id)

        failed++
        console.log(`[PAYMENT-VERIFY] ✗ Payment ${payment.reference} marked as failed`)
      }
      // Leave pending ones alone - they might still complete
    } catch (error) {
      console.error(`[PAYMENT-VERIFY] Error verifying payment ${payment.reference}:`, error)
    }
  }

  return { checked, credited, failed }
}
