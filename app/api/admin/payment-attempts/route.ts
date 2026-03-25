import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { notificationTemplates } from "@/lib/notification-service"
import { sendSMS } from "@/lib/sms-service"
import { atishareService } from "@/lib/at-ishare-service"
import { customerTrackingService } from "@/lib/customer-tracking-service"
import { isPhoneBlacklisted } from "@/lib/blacklist"
import {
  isAutoFulfillmentEnabled as isMTNAutoFulfillmentEnabled,
  createMTNOrder,
  saveMTNTracking,
  normalizePhoneNumber,
} from "@/lib/mtn-fulfillment"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Cleanup threshold: Mark pending attempts older than this as abandoned (in minutes)
const ABANDONED_THRESHOLD_MINUTES = 10

interface PaymentAttemptRecord {
  id: string
  user_id: string
  reference: string
  amount: number | null
  fee: number | null
  email: string | null
  status: string
  payment_type: string
  shop_id: string | null
  order_id: string | null
  gateway_response: string | null
  paystack_transaction_id: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

/**
 * Automatically mark stale pending payment attempts as abandoned
 * Runs on each GET request (non-blocking)
 */
async function cleanupAbandonedAttempts() {
  try {
    const cutoffTime = new Date(Date.now() - ABANDONED_THRESHOLD_MINUTES * 60 * 1000).toISOString()

    const { data, error } = await supabase
      .from("payment_attempts")
      .update({
        status: "abandoned",
        gateway_response: `Auto-marked as abandoned after ${ABANDONED_THRESHOLD_MINUTES} minutes`,
        updated_at: new Date().toISOString(),
      })
      .eq("status", "pending")
      .lt("created_at", cutoffTime)
      .select("id")

    if (error) {
      console.warn("[PAYMENT-ATTEMPTS] Cleanup error:", error.message)
    } else if (data && data.length > 0) {
      console.log(`[PAYMENT-ATTEMPTS] ✓ Marked ${data.length} stale attempts as abandoned`)
    }
  } catch (err) {
    console.warn("[PAYMENT-ATTEMPTS] Cleanup failed:", err)
  }
}

export async function GET(request: NextRequest) {
  try {
    // Run cleanup in background (non-blocking)
    cleanupAbandonedAttempts()

    const { searchParams } = new URL(request.url)

    // Pagination
    const page = parseInt(searchParams.get("page") || "1")
    const limit = parseInt(searchParams.get("limit") || "50")
    const offset = (page - 1) * limit

    // Filters
    const search = searchParams.get("search") || ""
    const status = searchParams.get("status") || ""
    const paymentType = searchParams.get("paymentType") || ""
    const startDate = searchParams.get("startDate") || ""
    const endDate = searchParams.get("endDate") || ""

    // Build query - no join to users since payment_attempts stores email directly
    let query = supabase
      .from("payment_attempts")
      .select(`*`, { count: "exact" })
      .order("created_at", { ascending: false })

    // Apply filters
    if (status) {
      query = query.eq("status", status)
    }

    if (paymentType) {
      query = query.eq("payment_type", paymentType)
    }

    if (startDate) {
      query = query.gte("created_at", startDate)
    }

    if (endDate) {
      const endDateObj = new Date(endDate)
      endDateObj.setDate(endDateObj.getDate() + 1)
      query = query.lt("created_at", endDateObj.toISOString())
    }

    // Search by email or reference
    if (search) {
      query = query.or(`reference.ilike.%${search}%,email.ilike.%${search}%`)
    }

    // Apply pagination
    query = query.range(offset, offset + limit - 1)

    const { data: attempts, error, count } = await query

    if (error) {
      console.error("[ADMIN-PAYMENT-ATTEMPTS] Error fetching payment attempts:", error)
      return NextResponse.json({ error: error.message }, { status: 400 })
    }

    // Format data - email is stored directly in payment_attempts
    const flattenedAttempts = (attempts as PaymentAttemptRecord[] | null)?.map((a: PaymentAttemptRecord) => ({
      ...a,
      amount: a.amount ?? 0,
      fee: a.fee ?? 0,
      user_email: a.email || "Unknown",
    })) || []

    // Calculate stats - use RPC or multiple count queries to avoid 1000 row limit
    const stats = {
      total: count || 0,
      pending: 0,
      completed: 0,
      failed: 0,
      abandoned: 0,
      totalAmount: 0,
      completedAmount: 0,
      walletTopups: 0,
      shopOrders: 0,
    }

    // Get status counts without 1000 limit
    const { count: pendingCount } = await supabase
      .from("payment_attempts")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")

    const { count: completedCount } = await supabase
      .from("payment_attempts")
      .select("id", { count: "exact", head: true })
      .eq("status", "completed")

    const { count: failedCount } = await supabase
      .from("payment_attempts")
      .select("id", { count: "exact", head: true })
      .eq("status", "failed")

    const { count: abandonedCount } = await supabase
      .from("payment_attempts")
      .select("id", { count: "exact", head: true })
      .eq("status", "abandoned")

    const { count: walletCount } = await supabase
      .from("payment_attempts")
      .select("id", { count: "exact", head: true })
      .eq("payment_type", "wallet_topup")

    const { count: shopCount } = await supabase
      .from("payment_attempts")
      .select("id", { count: "exact", head: true })
      .eq("payment_type", "shop_order")

    // Get sum totals - paginate to avoid 1000 row limit
    let allAmountData: any[] = []
    let amountOffset = 0
    const amountLimit = 1000
    let hasMoreAmounts = true

    while (hasMoreAmounts) {
      const { data: batchData } = await supabase
        .from("payment_attempts")
        .select("amount, status")
        .range(amountOffset, amountOffset + amountLimit - 1)

      if (batchData && batchData.length > 0) {
        allAmountData = allAmountData.concat(batchData)
        amountOffset += amountLimit
        hasMoreAmounts = batchData.length === amountLimit
      } else {
        hasMoreAmounts = false
      }
    }

    stats.pending = pendingCount || 0
    stats.completed = completedCount || 0
    stats.failed = failedCount || 0
    stats.abandoned = abandonedCount || 0
    stats.walletTopups = walletCount || 0
    stats.shopOrders = shopCount || 0

    allAmountData.forEach((a: { amount: number | null; status: string }) => {
      const amount = parseFloat(String(a.amount)) || 0
      stats.totalAmount += amount
      if (a.status === "completed") {
        stats.completedAmount += amount
      }
    })

    return NextResponse.json({
      attempts: flattenedAttempts,
      pagination: {
        page,
        limit,
        totalCount: count || 0,
        totalPages: Math.ceil((count || 0) / limit)
      },
      stats
    })
  } catch (error) {
    console.error("[ADMIN-PAYMENT-ATTEMPTS] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json()
    const { id, reference, status } = body

    if (!id && !reference) {
      return NextResponse.json({ error: "Payment attempt ID or reference is required" }, { status: 400 })
    }

    if (!status || !["completed", "failed", "pending", "abandoned"].includes(status)) {
      return NextResponse.json({ error: "Valid status is required (completed, failed, pending, abandoned)" }, { status: 400 })
    }

    // Fetch the full payment attempt record by ID or reference
    let query = supabase
      .from("payment_attempts")
      .select("*")

    if (id) {
      query = query.eq("id", id)
    } else {
      query = query.eq("reference", reference)
    }

    const { data: attempt, error: fetchError } = await query.single()

    if (fetchError || !attempt) {
      return NextResponse.json(
        { error: id ? "Payment attempt not found" : `No payment attempt found for reference: ${reference}` },
        { status: 404 }
      )
    }

    // Prevent duplicate non-completed status changes (e.g. failed→failed, abandoned→abandoned)
    // For 'completed': allow re-processing because the wallet credit may not have happened
    // (the transaction idempotency check below will safely prevent any double-credit)
    if (attempt.status === status && status !== "completed") {
      return NextResponse.json(
        { error: `This payment attempt is already marked as ${status}` },
        { status: 400 }
      )
    }

    // If marking as completed, process the payment FIRST before updating status
    // This prevents partial failure (status updated but wallet not credited)
    if (status === "completed") {
      const paymentType = attempt.payment_type
      const userId = attempt.user_id
      const amount = attempt.amount || 0
      const feeAmount = attempt.fee || 0
      const attemptReference = attempt.reference

      if (paymentType === "wallet_topup" && userId) {
        // ===== WALLET TOP-UP: Credit the user's wallet =====
        // amount in payment_attempts is stored as finalAmount (base amount) in initialize/route.ts
        // fee is stored separately. So we should NOT subtract fee again.
        const creditAmount = amount

        console.log(`[ADMIN-PAYMENT-ATTEMPTS] Processing wallet top-up for user ${userId}`)
        console.log(`  Total: GHS ${amount.toFixed(2)}, Fee: GHS ${feeAmount.toFixed(2)}, Credit: GHS ${creditAmount.toFixed(2)}`)

        // Get current wallet balance
        const { data: walletData, error: walletFetchError } = await supabase
          .from("wallets")
          .select("balance, total_credited")
          .eq("user_id", userId)
          .single()

        if (walletFetchError && walletFetchError.code !== "PGRST116") {
          console.error("[ADMIN-PAYMENT-ATTEMPTS] Error fetching wallet:", walletFetchError)
          return NextResponse.json({ error: "Failed to fetch wallet data" }, { status: 500 })
        }

        const currentBalance = walletData?.balance || 0
        const currentTotalCredited = walletData?.total_credited || 0

        // Check for duplicate transaction (idempotency)
        const { data: existingTransaction } = await supabase
          .from("transactions")
          .select("id")
          .eq("reference_id", attemptReference)
          .eq("user_id", userId)
          .eq("type", "credit")
          .maybeSingle()

        if (existingTransaction) {
          console.log(`[ADMIN-PAYMENT-ATTEMPTS] Reference ${attemptReference} already credited. Skipping duplicate.`)
          return NextResponse.json({ success: true, message: "Payment attempt already credited (duplicate reference)" })
        }

        const newBalance = currentBalance + creditAmount
        const newTotalCredited = currentTotalCredited + creditAmount

        // Update wallet balance
        const { error: walletUpdateError } = await supabase
          .from("wallets")
          .upsert(
            {
              user_id: userId,
              balance: newBalance,
              total_credited: newTotalCredited,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "user_id" }
          )

        if (walletUpdateError) {
          console.error("[ADMIN-PAYMENT-ATTEMPTS] Error updating wallet:", walletUpdateError)
          return NextResponse.json({ error: "Failed to credit wallet" }, { status: 500 })
        }

        console.log(`[ADMIN-PAYMENT-ATTEMPTS] ✓ Wallet credited: GHS ${creditAmount.toFixed(2)} (new balance: GHS ${newBalance.toFixed(2)})`)

        // Create transaction record
        const { error: transactionError } = await supabase
          .from("transactions")
          .insert([
            {
              user_id: userId,
              type: "credit",
              amount: creditAmount,
              reference_id: attemptReference,
              source: "wallet_topup",
              description: "Wallet top-up (manually completed by admin)",
              status: "completed",
              balance_before: currentBalance,
              balance_after: newBalance,
              created_at: new Date().toISOString(),
            },
          ])

        if (transactionError && transactionError.code !== "23505") {
          console.error("[ADMIN-PAYMENT-ATTEMPTS] Error creating transaction:", transactionError)
        }

        // Also update wallet_payments table to stay in sync
        supabase
          .from("wallet_payments")
          .update({
            status: "completed",
            updated_at: new Date().toISOString(),
          })
          .eq("reference", attemptReference)
          .then(({ error }) => {
            if (error) console.warn("[ADMIN-PAYMENT-ATTEMPTS] Failed to sync wallet_payments:", error.message)
            else console.log("[ADMIN-PAYMENT-ATTEMPTS] ✓ wallet_payments synced to completed")
          })

        // Send notification (non-blocking)
        try {
          const notificationData = notificationTemplates.balanceUpdated(newBalance)
          await supabase
            .from("notifications")
            .insert([
              {
                user_id: userId,
                title: notificationData.title,
                message: `${notificationData.message} Credited amount: GHS ${creditAmount.toFixed(2)}.`,
                type: notificationData.type,
                reference_id: `ADMIN_${attemptReference}`,
                action_url: "/dashboard/wallet",
                read: false,
              },
            ])
        } catch (notifError) {
          console.warn("[ADMIN-PAYMENT-ATTEMPTS] Notification failed:", notifError)
        }

        // Send SMS & Email (non-blocking)
        try {
          const { data: userData } = await supabase
            .from("users")
            .select("phone_number, first_name, email")
            .eq("id", userId)
            .single()

          if (userData?.phone_number) {
            const firstName = userData.first_name || "User"
            await sendSMS({
              phone: userData.phone_number,
              message: `Hi ${firstName}, your wallet has been topped up by GHS ${creditAmount.toFixed(2)}. New balance: GHS ${newBalance.toFixed(2)}`,
              type: "wallet_topup_success",
              reference: attempt.id,
            }).catch(err => console.error("[ADMIN-PAYMENT-ATTEMPTS] SMS error:", err))
          }

          if (userData?.email) {
            import("@/lib/email-service").then(({ sendEmail, EmailTemplates }) => {
              const payload = EmailTemplates.walletTopUpSuccess(
                creditAmount.toFixed(2),
                newBalance.toFixed(2),
                attemptReference
              )
              sendEmail({
                to: [{ email: userData.email, name: userData.first_name || "User" }],
                subject: payload.subject,
                htmlContent: payload.html,
                userId: userId,
                referenceId: attemptReference,
                type: "wallet_topup_success",
              }).catch(err => console.error("[ADMIN-PAYMENT-ATTEMPTS] Email error:", err))
            })
          }
        } catch (smsError) {
          console.warn("[ADMIN-PAYMENT-ATTEMPTS] SMS/Email failed:", smsError)
        }

      } else if (paymentType === "shop_order" && attempt.order_id && attempt.shop_id) {
        // ===== SHOP ORDER: Update payment status + trigger fulfillment =====
        console.log(`[ADMIN-PAYMENT-ATTEMPTS] Processing shop order ${attempt.order_id}`)

        // Get shop order details
        const { data: shopOrderData, error: orderFetchError } = await supabase
          .from("shop_orders")
          .select("id, shop_id, profit_amount, customer_phone, customer_email, customer_name, network, volume_gb, total_price, reference_code, parent_shop_id, parent_profit_amount, queue")
          .eq("id", attempt.order_id)
          .single()

        if (orderFetchError || !shopOrderData) {
          console.error("[ADMIN-PAYMENT-ATTEMPTS] Error fetching shop order:", orderFetchError)
          return NextResponse.json({ error: "Failed to fetch shop order details" }, { status: 500 })
        }

        // Update shop order payment status
        const { error: shopOrderError } = await supabase
          .from("shop_orders")
          .update({
            payment_status: "completed",
            updated_at: new Date().toISOString(),
          })
          .eq("id", attempt.order_id)

        if (shopOrderError) {
          console.error("[ADMIN-PAYMENT-ATTEMPTS] Error updating shop order:", shopOrderError)
          return NextResponse.json({ error: "Failed to update shop order payment status" }, { status: 500 })
        }

        console.log(`[ADMIN-PAYMENT-ATTEMPTS] ✓ Shop order ${attempt.order_id} payment status updated to completed`)

        // Also update wallet_payments table to stay in sync
        supabase
          .from("wallet_payments")
          .update({
            status: "completed",
            updated_at: new Date().toISOString(),
          })
          .eq("reference", attempt.reference)
          .then(({ error }) => {
            if (error) console.warn("[ADMIN-PAYMENT-ATTEMPTS] Failed to sync wallet_payments:", error.message)
            else console.log("[ADMIN-PAYMENT-ATTEMPTS] ✓ wallet_payments synced to completed")
          })

        // Track customer (non-blocking)
        try {
          const trackingResult = await customerTrackingService.trackCustomer({
            shopId: shopOrderData.shop_id,
            phoneNumber: shopOrderData.customer_phone,
            email: shopOrderData.customer_email || "",
            customerName: shopOrderData.customer_name || "Customer",
            totalPrice: shopOrderData.total_price,
            slug: "storefront",
            orderId: attempt.order_id,
          })

          if (trackingResult?.customerId) {
            await supabase
              .from("shop_orders")
              .update({ shop_customer_id: trackingResult.customerId })
              .eq("id", attempt.order_id)
          }
        } catch (trackingError) {
          console.error("[ADMIN-PAYMENT-ATTEMPTS] Customer tracking error:", trackingError)
        }

        // Send SMS to customer (non-blocking)
        if (shopOrderData.customer_phone && shopOrderData.queue !== "blacklisted") {
          try {
            const { data: shopDetailsData } = await supabase
              .from("user_shops")
              .select("shop_name, user_id")
              .eq("id", attempt.shop_id)
              .single()

            let shopName = shopDetailsData?.shop_name || "Shop"
            let shopOwnerPhone = "Support"

            if (shopDetailsData?.user_id) {
              const { data: ownerData } = await supabase
                .from("users")
                .select("phone_number")
                .eq("id", shopDetailsData.user_id)
                .single()

              if (ownerData?.phone_number) {
                shopOwnerPhone = ownerData.phone_number
              }
            }

            const smsMessage = `${shopName}: You have successfully placed an order of ${shopOrderData.network} ${shopOrderData.volume_gb}GB to ${shopOrderData.customer_phone}. If delayed over 2 hours, contact shop owner: ${shopOwnerPhone}`

            await sendSMS({
              phone: shopOrderData.customer_phone,
              message: smsMessage,
              type: "order_payment_confirmed",
              reference: attempt.order_id,
            }).catch(err => console.error("[ADMIN-PAYMENT-ATTEMPTS] SMS error:", err))

            if (shopOrderData.customer_email) {
              import("@/lib/email-service").then(({ sendEmail, EmailTemplates }) => {
                const payload = EmailTemplates.orderPaymentConfirmed(
                  attempt.order_id,
                  shopOrderData.network,
                  shopOrderData.volume_gb,
                  (shopOrderData.total_price || 0).toFixed(2)
                )
                sendEmail({
                  to: [{ email: shopOrderData.customer_email, name: shopOrderData.customer_name }],
                  subject: payload.subject,
                  htmlContent: (payload as any).htmlContent || payload.html,
                  referenceId: attempt.order_id,
                  type: "order_payment_confirmed",
                }).catch(err => console.error("[ADMIN-PAYMENT-ATTEMPTS] Email error:", err))
              })
            }
          } catch (smsError) {
            console.warn("[ADMIN-PAYMENT-ATTEMPTS] SMS notification failed:", smsError)
          }
        }

        // Trigger auto-fulfillment
        const networkLower = (shopOrderData.network || "").toLowerCase()

        // AT-iShare / Telecel / BigTime fulfillment
        const fulfillableNetworks = ["at - ishare", "at-ishare", "telecel", "at - bigtime", "at-bigtime"]
        const isAutoFulfillable = fulfillableNetworks.some(n => networkLower === n || networkLower.includes(n.replace("at - ", "at-")))

        let autoFulfillEnabled = true
        try {
          const { data: settingData } = await supabase
            .from("admin_settings")
            .select("value")
            .eq("key", "auto_fulfillment_enabled")
            .single()
          autoFulfillEnabled = settingData?.value?.enabled ?? true
        } catch { }

        if (isAutoFulfillable && autoFulfillEnabled && shopOrderData.customer_phone && shopOrderData.queue !== "blacklisted") {
          let sizeGb = 0
          if (typeof shopOrderData.volume_gb === "number") {
            sizeGb = shopOrderData.volume_gb
          } else if (shopOrderData.volume_gb) {
            sizeGb = parseInt(shopOrderData.volume_gb.toString().replace(/[^0-9]/g, "")) || 0
          }

          if (sizeGb > 0) {
            const isBigTime = networkLower.includes("bigtime")
            const apiNetwork = networkLower.includes("telecel") ? "TELECEL" : "AT"

            atishareService.fulfillOrder({
              phoneNumber: shopOrderData.customer_phone,
              sizeGb,
              orderId: attempt.order_id,
              network: apiNetwork,
              orderType: "shop",
              isBigTime,
            }).then(result => {
              console.log(`[ADMIN-PAYMENT-ATTEMPTS] ✓ Fulfillment triggered for order ${attempt.order_id}:`, result)
            }).catch(err => {
              console.error(`[ADMIN-PAYMENT-ATTEMPTS] ❌ Fulfillment error for order ${attempt.order_id}:`, err)
            })
          }
        }

        // MTN fulfillment
        const isMTNNetwork = networkLower === "mtn"
        if (isMTNNetwork && shopOrderData.customer_phone && shopOrderData.queue !== "blacklisted") {
          const sizeGb = parseInt(shopOrderData.volume_gb?.toString().replace(/[^0-9]/g, "") || "0") || 0
          const normalizedPhone = normalizePhoneNumber(shopOrderData.customer_phone)
          const mtnAutoEnabled = await isMTNAutoFulfillmentEnabled()

          if (mtnAutoEnabled && sizeGb > 0) {
            try {
              const isBlacklisted = await isPhoneBlacklisted(shopOrderData.customer_phone)
              if (!isBlacklisted) {
                const mtnRequest = {
                  recipient_phone: normalizedPhone,
                  network: "MTN" as const,
                  size_gb: sizeGb,
                }
                const mtnResult = await createMTNOrder(mtnRequest)
                console.log(`[ADMIN-PAYMENT-ATTEMPTS] ✓ MTN API response for order ${attempt.order_id}:`, mtnResult)

                if (mtnResult.order_id) {
                  await saveMTNTracking(
                    attempt.order_id,
                    mtnResult.order_id,
                    mtnRequest,
                    mtnResult,
                    "shop",
                    mtnResult.provider || "sykes"
                  )
                }

                if (mtnResult.success) {
                  await supabase
                    .from("shop_orders")
                    .update({
                      order_status: "processing",
                      fulfillment_method: "auto_mtn",
                      updated_at: new Date().toISOString(),
                    })
                    .eq("id", attempt.order_id)
                }
              }
            } catch (err) {
              console.error(`[ADMIN-PAYMENT-ATTEMPTS] ❌ MTN fulfillment error:`, err)
            }
          }
        }

        // Create shop profit record + sync available balance
        if (shopOrderData.profit_amount > 0) {
          const { data: currentBalance } = await supabase
            .from("shop_available_balance")
            .select("available_balance")
            .eq("shop_id", attempt.shop_id)
            .single()

          const balanceBefore = currentBalance?.available_balance || 0
          const balanceAfter = balanceBefore + shopOrderData.profit_amount

          const { error: profitError } = await supabase
            .from("shop_profits")
            .insert([
              {
                shop_id: attempt.shop_id,
                shop_order_id: attempt.order_id,
                profit_amount: shopOrderData.profit_amount,
                profit_balance_before: balanceBefore,
                profit_balance_after: balanceAfter,
                status: "credited",
                created_at: new Date().toISOString(),
              },
            ])

          if (!profitError) {
            console.log(`[ADMIN-PAYMENT-ATTEMPTS] ✓ Shop profit record created: GHS ${shopOrderData.profit_amount.toFixed(2)}`)

            // Sync shop_available_balance (delete + re-insert like webhook does)
            await syncShopAvailableBalance(attempt.shop_id)
          }
        }

        // Create parent shop profit record if sub-agent sale
        if (shopOrderData.parent_shop_id && shopOrderData.parent_profit_amount > 0) {
          const { data: parentCurrentBalance } = await supabase
            .from("shop_available_balance")
            .select("available_balance")
            .eq("shop_id", shopOrderData.parent_shop_id)
            .single()

          const parentBalanceBefore = parentCurrentBalance?.available_balance || 0
          const parentBalanceAfter = parentBalanceBefore + shopOrderData.parent_profit_amount

          const { error: parentProfitError } = await supabase
            .from("shop_profits")
            .insert([
              {
                shop_id: shopOrderData.parent_shop_id,
                shop_order_id: attempt.order_id,
                profit_amount: shopOrderData.parent_profit_amount,
                profit_balance_before: parentBalanceBefore,
                profit_balance_after: parentBalanceAfter,
                status: "credited",
                created_at: new Date().toISOString(),
              },
            ])

          if (!parentProfitError) {
            console.log(`[ADMIN-PAYMENT-ATTEMPTS] ✓ Parent shop profit created: GHS ${shopOrderData.parent_profit_amount.toFixed(2)}`)

            // Sync parent shop_available_balance
            await syncShopAvailableBalance(shopOrderData.parent_shop_id)
          }
        }
      }
    }

    // NOW update the payment_attempts status (after successful processing)
    const updateData: Record<string, string> = {
      status,
      updated_at: new Date().toISOString(),
      gateway_response: `Manually marked as ${status} by admin`,
    }

    if (status === "completed") {
      updateData.completed_at = new Date().toISOString()
    }

    const { error: updateError } = await supabase
      .from("payment_attempts")
      .update(updateData)
      .eq("id", attempt.id)

    if (updateError) {
      console.error("[ADMIN-PAYMENT-ATTEMPTS] Error updating status:", updateError)
      return NextResponse.json({ error: updateError.message }, { status: 400 })
    }

    console.log(`[ADMIN-PAYMENT-ATTEMPTS] ✓ Payment attempt ${attempt.id} (ref: ${attempt.reference}) marked as ${status} by admin`)

    return NextResponse.json({ success: true, message: `Payment attempt marked as ${status}` })
  } catch (error) {
    console.error("[ADMIN-PAYMENT-ATTEMPTS] PATCH Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}

/**
 * Sync shop_available_balance by recalculating from profits and withdrawals
 * (Matches the webhook's delete + re-insert pattern)
 */
async function syncShopAvailableBalance(shopId: string) {
  try {
    // Fetch all profits with pagination
    let allProfits: any[] = []
    let offset = 0
    const batchSize = 1000
    let hasMore = true

    while (hasMore) {
      const { data, error } = await supabase
        .from("shop_profits")
        .select("profit_amount, status")
        .eq("shop_id", shopId)
        .range(offset, offset + batchSize - 1)

      if (error) break
      if (data && data.length > 0) {
        allProfits = allProfits.concat(data)
        offset += batchSize
        hasMore = data.length === batchSize
      } else {
        hasMore = false
      }
    }

    const breakdown = {
      totalProfit: 0,
      creditedProfit: 0,
      withdrawnProfit: 0,
    }

    allProfits.forEach((p: any) => {
      const amt = p.profit_amount || 0
      breakdown.totalProfit += amt
      if (p.status === "credited") breakdown.creditedProfit += amt
      else if (p.status === "withdrawn") breakdown.withdrawnProfit += amt
    })

    // Fetch approved withdrawals with pagination
    let allWithdrawals: any[] = []
    offset = 0
    hasMore = true

    while (hasMore) {
      const { data, error } = await supabase
        .from("withdrawal_requests")
        .select("amount")
        .eq("shop_id", shopId)
        .eq("status", "approved")
        .range(offset, offset + batchSize - 1)

      if (error) break
      if (data && data.length > 0) {
        allWithdrawals = allWithdrawals.concat(data)
        offset += batchSize
        hasMore = data.length === batchSize
      } else {
        hasMore = false
      }
    }

    const totalApprovedWithdrawals = allWithdrawals.reduce((sum: number, w: any) => sum + (w.amount || 0), 0)
    const availableBalance = Math.max(0, breakdown.creditedProfit - totalApprovedWithdrawals)

    console.log(`[ADMIN-PAYMENT-ATTEMPTS] Balance sync for shop ${shopId}:`, {
      creditedProfit: breakdown.creditedProfit,
      totalApprovedWithdrawals,
      availableBalance,
    })

    // Delete existing and insert fresh
    await supabase
      .from("shop_available_balance")
      .delete()
      .eq("shop_id", shopId)

    const { error: insertError } = await supabase
      .from("shop_available_balance")
      .insert([
        {
          shop_id: shopId,
          available_balance: availableBalance,
          total_profit: breakdown.totalProfit,
          withdrawn_amount: breakdown.withdrawnProfit,
          credited_profit: breakdown.creditedProfit,
          withdrawn_profit: breakdown.withdrawnProfit,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ])

    if (!insertError) {
      console.log(`[ADMIN-PAYMENT-ATTEMPTS] ✓ Available balance synced for shop ${shopId}: GHS ${availableBalance.toFixed(2)}`)
    } else {
      console.error(`[ADMIN-PAYMENT-ATTEMPTS] Error syncing balance for shop ${shopId}:`, insertError)
    }
  } catch (syncError) {
    console.error(`[ADMIN-PAYMENT-ATTEMPTS] Error syncing shop balance for ${shopId}:`, syncError)
  }
}

