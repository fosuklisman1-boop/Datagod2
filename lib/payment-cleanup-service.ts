/**
 * Payment Cleanup Service
 * Handles cleanup of abandoned payments and verification of pending payments
 */

import { createClient } from "@supabase/supabase-js"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import { notificationTemplates } from "@/lib/notification-service"
import { sendPushToUser } from "./push-service"
import { netCreditAmount } from "@/lib/payment-amounts"

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
    .select("id, reference, user_id, amount, fee, created_at, shop_id, order_id, order_type")
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
        // Skip dealer upgrade payments - those are handled by the webhook
        if (payment.order_type === "dealer_upgrade") {
          console.log(`[PAYMENT-CLEANUP] Payment ${payment.reference} is a dealer upgrade - marking completed but NOT crediting wallet`)
          await supabase
            .from("wallet_payments")
            .update({ status: "completed", updated_at: new Date().toISOString() })
            .eq("id", payment.id)
          verified++
          continue
        }

        console.log(`[PAYMENT-CLEANUP] Payment ${payment.reference} was successful - crediting wallet via RPC`)
        
        // Fetch the net amount from payment_attempts to be 100% sure we credit ONLY the net amount (excluding fee)
        const { data: attempt } = await supabase
          .from("payment_attempts")
          .select("amount")
          .eq("reference", payment.reference)
          .maybeSingle()

        // Net (fee-exclusive) amount to credit; see netCreditAmount. Note:
        // wallet_payments.amount usually INCLUDES the fee.
        const netAmount = netCreditAmount(attempt?.amount, payment.amount, payment.fee)

        // Use the atomic credit_wallet_safely RPC
        // This handles: Idempotency (transactions table), atomic wallet update, and transaction logging
        const { data: rpcData, error: rpcError } = await supabase.rpc("credit_wallet_safely", {
          p_user_id: payment.user_id,
          p_amount: netAmount,
          p_reference_id: payment.reference,
          p_description: "Wallet top-up via Paystack (recovered by system)",
          p_source: "wallet_topup"
        })

        if (rpcError) {
          console.error(`[PAYMENT-CLEANUP] RPC Error crediting ${payment.reference}:`, rpcError)
          continue
        }

        const { already_processed: alreadyProcessed } = rpcData[0]

        if (alreadyProcessed) {
          console.log(`[PAYMENT-CLEANUP] ✓ Reference ${payment.reference} already credited (idempotency caught).`)
        } else {
          console.log(`[PAYMENT-CLEANUP] ✓ Wallet credited via RPC for user ${payment.user_id}`)
          credited++

          // Send SMS, email, and in-app notification for recovered payment
          const { new_balance: newBalance } = rpcData[0]
          try {
            const { data: userData } = await supabase
              .from("users")
              .select("phone_number, first_name, email")
              .eq("id", payment.user_id)
              .single()

            if (userData?.phone_number) {
              const firstName = userData.first_name || 'User'
              await sendSMS({
                phone: userData.phone_number,
                message: SMSTemplates.walletToppedUp(firstName, netAmount.toFixed(2), newBalance.toFixed(2)),
                type: 'wallet_topup_success',
                reference: payment.id,
              }).catch(err => console.error("[PAYMENT-CLEANUP] SMS error:", err))
              console.log(`[PAYMENT-CLEANUP] ✓ SMS sent to user ${payment.user_id}`)
            }

            // Send email
            if (userData?.email) {
              import("@/lib/email-service").then(({ sendEmail, EmailTemplates }) => {
                const payload = EmailTemplates.walletTopUpSuccess(
                  netAmount.toFixed(2),
                  newBalance.toFixed(2),
                  payment.reference
                );
                sendEmail({
                  to: [{ email: userData.email, name: userData.first_name || "User" }],
                  subject: payload.subject,
                  htmlContent: payload.html,
                  userId: payment.user_id,
                  referenceId: payment.reference,
                  type: 'wallet_topup_success'
                }).catch(err => console.error("[PAYMENT-CLEANUP] Email error:", err));
              });
            }
          } catch (notifError) {
            console.warn("[PAYMENT-CLEANUP] Notification error (non-blocking):", notifError)
          }

          // In-app notification
          try {
            const notifData = notificationTemplates.balanceUpdated(newBalance)
            await supabase.from("notifications").insert([{
              user_id: payment.user_id,
              title: notifData.title,
              message: `${notifData.message} Credited amount: GHS ${netAmount.toFixed(2)}.`,
              type: notifData.type,
              reference_id: `PAYSTACK_${payment.reference}`,
              action_url: "/dashboard/wallet",
              read: false,
            }])
            sendPushToUser(payment.user_id, {
              title: notifData.title,
              body: `${notifData.message} Credited amount: GHS ${netAmount.toFixed(2)}.`,
              data: { url: "/dashboard/wallet" },
            }).catch(() => {})
          } catch (notifError) {
            console.warn("[PAYMENT-CLEANUP] In-app notification error:", notifError)
          }
        }

        // Update payment status in wallet_payments table to match
        await supabase
          .from("wallet_payments")
          .update({ status: "completed", updated_at: new Date().toISOString() })
          .eq("id", payment.id)

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
    .select("id, reference, amount, fee, shop_id, order_type")
    .eq("user_id", userId)
    .eq("status", "pending")
    .gt("created_at", cutoffTime)
    .is("shop_id", null) // Only wallet top-ups, not shop orders
    .neq("order_type", "dealer_upgrade") // Exclude dealer upgrades - handled by webhook

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
        // Fetch the net amount from payment_attempts to be 100% sure we credit ONLY the net amount (excluding fee)
        const { data: attempt } = await supabase
          .from("payment_attempts")
          .select("amount")
          .eq("reference", payment.reference)
          .maybeSingle()

        // Net (fee-exclusive) amount to credit; see netCreditAmount.
        const netAmount = netCreditAmount(attempt?.amount, payment.amount, payment.fee)

        // Use the atomic credit_wallet_safely RPC
        // This handles: Idempotency (transactions table), atomic wallet update, and transaction logging
        const { data: rpcData, error: rpcError } = await supabase.rpc("credit_wallet_safely", {
          p_user_id: userId,
          p_amount: netAmount,
          p_reference_id: payment.reference,
          p_description: "Wallet top-up via Paystack (verified manually)",
          p_source: "wallet_topup"
        })

        if (rpcError) {
          console.error(`[PAYMENT-VERIFY] RPC Error crediting ${payment.reference}:`, rpcError)
          continue
        }

        const { already_processed: alreadyProcessed } = rpcData[0]

        if (alreadyProcessed) {
          console.log(`[PAYMENT-VERIFY] ✓ Reference ${payment.reference} already credited (idempotency caught).`)
        } else {
          console.log(`[PAYMENT-VERIFY] ✓ Wallet credited via RPC for user ${userId}`)
          credited++

          // Send SMS, email, and in-app notification for verified payment
          // (netAmount from above is identical — same inputs — so reuse it).
          const { new_balance: newBalance } = rpcData[0]
          try {
            const { data: userData } = await supabase
              .from("users")
              .select("phone_number, first_name, email")
              .eq("id", userId)
              .single()

            if (userData?.phone_number) {
              const firstName = userData.first_name || 'User'
              await sendSMS({
                phone: userData.phone_number,
                message: SMSTemplates.walletToppedUp(firstName, netAmount.toFixed(2), newBalance.toFixed(2)),
                type: 'wallet_topup_success',
                reference: payment.id,
              }).catch(err => console.error("[PAYMENT-VERIFY] SMS error:", err))
              console.log(`[PAYMENT-VERIFY] ✓ SMS sent to user ${userId}`)
            }

            // Send email
            if (userData?.email) {
              import("@/lib/email-service").then(({ sendEmail, EmailTemplates }) => {
                const payload = EmailTemplates.walletTopUpSuccess(
                  netAmount.toFixed(2),
                  newBalance.toFixed(2),
                  payment.reference
                );
                sendEmail({
                  to: [{ email: userData.email, name: userData.first_name || "User" }],
                  subject: payload.subject,
                  htmlContent: payload.html,
                  userId: userId,
                  referenceId: payment.reference,
                  type: 'wallet_topup_success'
                }).catch(err => console.error("[PAYMENT-VERIFY] Email error:", err));
              });
            }
          } catch (notifError) {
            console.warn("[PAYMENT-VERIFY] Notification error (non-blocking):", notifError)
          }

          // In-app notification
          try {
            const notifData = notificationTemplates.balanceUpdated(newBalance)
            await supabase.from("notifications").insert([{
              user_id: userId,
              title: notifData.title,
              message: `${notifData.message} Credited amount: GHS ${netAmount.toFixed(2)}.`,
              type: notifData.type,
              reference_id: `PAYSTACK_${payment.reference}`,
              action_url: "/dashboard/wallet",
              read: false,
            }])
            sendPushToUser(userId, {
              title: notifData.title,
              body: `${notifData.message} Credited amount: GHS ${netAmount.toFixed(2)}.`,
              data: { url: "/dashboard/wallet" },
            }).catch(() => {})
          } catch (notifError) {
            console.warn("[PAYMENT-VERIFY] In-app notification error:", notifError)
          }
        }

        // Update payment status in wallet_payments table to match
        await supabase
          .from("wallet_payments")
          .update({ status: "completed", updated_at: new Date().toISOString() })
          .eq("id", payment.id)

        console.log(`[PAYMENT-VERIFY] ✓ Payment ${payment.reference} verified and completed`)
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

/**
 * Verify and (if successful) credit a SINGLE wallet top-up by its Paystack
 * reference — for a customer who names a specific/older payment the 24h pending
 * scan won't catch. Strictly scoped: the reference must be a wallet top-up that
 * belongs to `userId`. Crediting is idempotent (credit_wallet_safely), so this
 * is safe to call repeatedly and alongside the webhook.
 */
export async function verifyUserPaymentByReference(
  userId: string,
  reference: string
): Promise<{ outcome: "credited" | "already_credited" | "failed" | "pending" | "not_found"; newBalance?: number }> {
  const supabase = getSupabaseAdmin()
  const ref = String(reference || "").trim()
  if (!ref) return { outcome: "not_found" }

  const { data: payment } = await supabase
    .from("wallet_payments")
    .select("id, reference, amount, fee, status, user_id, order_id, shop_id, order_type")
    .eq("reference", ref)
    .maybeSingle()

  // Must be a wallet top-up owned by this user (not someone else's, not a
  // shop/data/upgrade payment).
  if (!payment || payment.user_id !== userId) return { outcome: "not_found" }
  if (payment.order_id || payment.shop_id || payment.order_type === "dealer_upgrade") return { outcome: "not_found" }

  const paystack = await verifyWithPaystack(ref)
  if (paystack.status === "failed" || paystack.status === "abandoned") {
    await supabase.from("wallet_payments").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", payment.id)
    return { outcome: "failed" }
  }
  if (paystack.status !== "success") return { outcome: "pending" }

  // Credit the NET amount (fee-exclusive), matching the webhook. Prefer the
  // payment_attempts net value; fall back to gross - fee.
  const { data: attempt } = await supabase
    .from("payment_attempts")
    .select("amount")
    .eq("reference", ref)
    .maybeSingle()
  const netAmount = netCreditAmount(attempt?.amount, payment.amount, payment.fee)

  const { data: rpcData, error: rpcError } = await supabase.rpc("credit_wallet_safely", {
    p_user_id: userId,
    p_amount: netAmount,
    p_reference_id: ref,
    p_description: "Wallet top-up via Paystack (verified in chat)",
    p_source: "wallet_topup",
  })
  if (rpcError || !rpcData?.[0]) return { outcome: "pending" }

  const { new_balance: newBalance, already_processed: alreadyProcessed } = rpcData[0]
  await supabase.from("wallet_payments").update({ status: "completed", updated_at: new Date().toISOString() }).eq("id", payment.id)

  if (!alreadyProcessed) {
    try {
      const { data: u } = await supabase.from("users").select("phone_number, first_name").eq("id", userId).single()
      if (u?.phone_number) {
        await sendSMS({
          phone: u.phone_number,
          message: SMSTemplates.walletToppedUp(u.first_name || "User", Number(netAmount).toFixed(2), Number(newBalance).toFixed(2)),
          type: "wallet_topup_success",
          reference: payment.id,
        }).catch(() => {})
      }
    } catch { /* notification is best-effort */ }
  }

  return { outcome: alreadyProcessed ? "already_credited" : "credited", newBalance }
}
