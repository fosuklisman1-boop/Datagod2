import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || ""
const PAYSTACK_BASE_URL = "https://api.paystack.co"

// Time threshold: orders pending for more than 10 minutes
const PENDING_THRESHOLD_MINUTES = 10

/**
 * Verify payment status with Paystack API
 */
async function verifyWithPaystack(reference: string): Promise<{
  success: boolean
  status: "success" | "failed" | "pending" | "abandoned"
  amount?: number
  message?: string
}> {
  try {
    const response = await fetch(
      `${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        },
      }
    )

    const data = await response.json()

    if (!response.ok || !data.status) {
      return {
        success: false,
        status: "pending",
        message: data.message || "Verification failed",
      }
    }

    return {
      success: true,
      status: data.data?.status || "pending",
      amount: data.data?.amount ? data.data.amount / 100 : 0,
      message: data.message,
    }
  } catch (error) {
    console.error("[VERIFY-PAYMENT] Paystack API error:", error)
    return {
      success: false,
      status: "pending",
      message: error instanceof Error ? error.message : "API error",
    }
  }
}

/**
 * Trigger fulfillment for a verified order
 */
async function triggerFulfillment(order: {
  id: string
  network: string
  customer_phone: string
  volume_gb: number
  customer_name?: string
}): Promise<{ success: boolean; message: string }> {
  try {
    console.log(`[VERIFY-PAYMENT] Triggering fulfillment for order ${order.id}`)
    
    // Call the fulfillment process-order endpoint internally
    const baseUrl = process.env.NEXT_PUBLIC_API_URL || process.env.VERCEL_URL 
      ? `https://${process.env.VERCEL_URL}` 
      : "http://localhost:3000"
    
    const response = await fetch(`${baseUrl}/api/fulfillment/process-order`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        shop_order_id: order.id,
        network: order.network,
        phone_number: order.customer_phone,
        volume_gb: order.volume_gb,
        customer_name: order.customer_name || "Customer",
      }),
    })

    const data = await response.json()
    
    if (response.ok && data.success) {
      return { success: true, message: data.message || "Fulfillment triggered" }
    } else {
      return { success: false, message: data.error || "Fulfillment failed" }
    }
  } catch (error) {
    console.error(`[VERIFY-PAYMENT] Fulfillment error for ${order.id}:`, error)
    return { success: false, message: error instanceof Error ? error.message : "Error" }
  }
}

/**
 * GET /api/cron/verify-pending-payments
 * 
 * Cron job to verify pending payments with Paystack and trigger fulfillment.
 * Runs every 2 minutes to check payments pending for more than 10 minutes.
 */
export async function GET(request: NextRequest) {
  try {
    console.log("[VERIFY-PAYMENT] Starting pending payment verification...")

    // Calculate threshold time (10 minutes ago)
    const thresholdTime = new Date(Date.now() - PENDING_THRESHOLD_MINUTES * 60 * 1000).toISOString()

    // Get pending shop_orders with payment references older than threshold
    // Also ensure order_status is not already processing/completed (prevents double fulfillment)
    const { data: pendingOrders, error: fetchError } = await supabase
      .from("shop_orders")
      .select("id, payment_reference, network, customer_phone, volume_gb, customer_name, payment_status, order_status, created_at")
      .eq("payment_status", "pending")
      .in("order_status", ["pending", "awaiting_payment"]) // Only orders not yet fulfilled
      .not("payment_reference", "is", null)
      .lt("created_at", thresholdTime)
      .order("created_at", { ascending: true })
      .limit(50)

    if (fetchError) {
      console.error("[VERIFY-PAYMENT] Error fetching pending orders:", fetchError)
      return NextResponse.json({ error: "Failed to fetch orders" }, { status: 500 })
    }

    if (!pendingOrders || pendingOrders.length === 0) {
      console.log("[VERIFY-PAYMENT] No pending payments to verify")
      return NextResponse.json({
        success: true,
        message: "No pending payments to verify",
        verified: 0,
      })
    }

    console.log(`[VERIFY-PAYMENT] Found ${pendingOrders.length} pending payments to verify`)

    let verified = 0
    let failed = 0
    let stillPending = 0
    let fulfilled = 0
    const results: Array<{
      id: string
      reference: string
      paystack_status: string
      action: string
      fulfillment?: string
    }> = []

    for (const order of pendingOrders) {
      try {
        // Verify with Paystack
        const paystackResult = await verifyWithPaystack(order.payment_reference)
        console.log(`[VERIFY-PAYMENT] Order ${order.id}: Paystack status = ${paystackResult.status}`)

        if (paystackResult.status === "success") {
          // Payment is successful - update and trigger fulfillment
          
          // SAFETY CHECK: Re-fetch order to ensure it wasn't already processed
          const { data: currentOrder } = await supabase
            .from("shop_orders")
            .select("payment_status, order_status")
            .eq("id", order.id)
            .single()
          
          if (currentOrder?.payment_status === "completed" || 
              currentOrder?.order_status === "processing" || 
              currentOrder?.order_status === "completed") {
            console.log(`[VERIFY-PAYMENT] ⏭️ Order ${order.id} already processed, skipping`)
            results.push({
              id: order.id,
              reference: order.payment_reference,
              paystack_status: "success",
              action: "already_processed",
            })
            continue
          }

          // Check if fulfillment tracking already exists (prevents double fulfillment)
          const { data: existingTracking } = await supabase
            .from("mtn_fulfillment_tracking")
            .select("id, status")
            .eq("shop_order_id", order.id)
            .single()
          
          if (existingTracking) {
            console.log(`[VERIFY-PAYMENT] ⏭️ Order ${order.id} already has fulfillment tracking, skipping fulfillment`)
            // Still update payment status if needed
            await supabase
              .from("shop_orders")
              .update({ payment_status: "completed", updated_at: new Date().toISOString() })
              .eq("id", order.id)
            
            results.push({
              id: order.id,
              reference: order.payment_reference,
              paystack_status: "success",
              action: "payment_updated_fulfillment_exists",
              fulfillment: `Already tracked: ${existingTracking.status}`,
            })
            verified++
            continue
          }

          const { error: updateError } = await supabase
            .from("shop_orders")
            .update({
              payment_status: "completed",
              updated_at: new Date().toISOString(),
            })
            .eq("id", order.id)

          if (updateError) {
            console.error(`[VERIFY-PAYMENT] Failed to update order ${order.id}:`, updateError)
            results.push({
              id: order.id,
              reference: order.payment_reference,
              paystack_status: "success",
              action: "update_failed",
            })
            failed++
            continue
          }

          // Trigger fulfillment
          const fulfillmentResult = await triggerFulfillment({
            id: order.id,
            network: order.network,
            customer_phone: order.customer_phone,
            volume_gb: order.volume_gb,
            customer_name: order.customer_name,
          })

          results.push({
            id: order.id,
            reference: order.payment_reference,
            paystack_status: "success",
            action: "verified_and_updated",
            fulfillment: fulfillmentResult.success ? "triggered" : fulfillmentResult.message,
          })
          
          verified++
          if (fulfillmentResult.success) fulfilled++
          
          console.log(`[VERIFY-PAYMENT] ✅ Order ${order.id}: Payment verified & fulfillment ${fulfillmentResult.success ? "triggered" : "failed"}`)

        } else if (paystackResult.status === "failed" || paystackResult.status === "abandoned") {
          // Payment failed - update status
          const { error: updateError } = await supabase
            .from("shop_orders")
            .update({
              payment_status: "failed",
              updated_at: new Date().toISOString(),
            })
            .eq("id", order.id)

          if (!updateError) {
            results.push({
              id: order.id,
              reference: order.payment_reference,
              paystack_status: paystackResult.status,
              action: "marked_failed",
            })
            failed++
            console.log(`[VERIFY-PAYMENT] ❌ Order ${order.id}: Payment ${paystackResult.status}`)
          }

        } else {
          // Still pending on Paystack
          results.push({
            id: order.id,
            reference: order.payment_reference,
            paystack_status: "pending",
            action: "still_pending",
          })
          stillPending++
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200))

      } catch (err) {
        console.error(`[VERIFY-PAYMENT] Error processing order ${order.id}:`, err)
        results.push({
          id: order.id,
          reference: order.payment_reference,
          paystack_status: "error",
          action: err instanceof Error ? err.message : "Unknown error",
        })
        failed++
      }
    }

    console.log(`[VERIFY-PAYMENT] Complete: ${verified} verified, ${fulfilled} fulfilled, ${failed} failed, ${stillPending} still pending`)

    return NextResponse.json({
      success: true,
      message: `Verified ${pendingOrders.length} pending payments`,
      total: pendingOrders.length,
      verified,
      fulfilled,
      failed,
      stillPending,
      results,
    })

  } catch (error) {
    console.error("[VERIFY-PAYMENT] Error:", error)
    return NextResponse.json(
      { error: "Internal server error", details: error instanceof Error ? error.message : "" },
      { status: 500 }
    )
  }
}
