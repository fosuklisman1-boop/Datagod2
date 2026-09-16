/**
 * AFA Fulfillment Helper
 *
 * Shared logic for fulfilling a single AFA order via the Sykes API.
 * Imported by both the submit route (auto-fulfillment) and the admin
 * fulfillment endpoint (manual / bulk trigger).
 */

import { createClient } from "@supabase/supabase-js"
import { registerAfaViaSykes } from "@/lib/sykes-afa-provider"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import { secureString } from "@/lib/secure-random"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

function getSupabase() {
  return createClient(supabaseUrl, serviceRoleKey)
}

export interface FulfillResult {
  success: boolean
  message: string
  fulfillmentRef?: string
}

/**
 * Fulfill a single AFA order by ID.
 * - Fetches order data from DB
 * - Calls Sykes /api/afa/register
 * - Updates afa_orders.fulfillment_status and related columns
 * - Sets afa_orders.status = "completed" on success
 */
export async function fulfillAfaOrder(orderId: string): Promise<FulfillResult> {
  const supabase = getSupabase()

  console.log("[AFA-FULFILL] Starting fulfillment for order:", orderId)

  // 1. Fetch the order
  const { data: order, error: fetchError } = await supabase
    .from("afa_orders")
    .select("id, full_name, gh_card_number, occupation, phone_number, location, fulfillment_status, fulfillment_attempts, status")
    .eq("id", orderId)
    .single()

  if (fetchError || !order) {
    console.error("[AFA-FULFILL] Order not found:", orderId, fetchError)
    return { success: false, message: "Order not found" }
  }

  // 2. Guard: skip already-fulfilled, completed, or cancelled orders
  if (order.fulfillment_status === "fulfilled") {
    return { success: false, message: "Order already fulfilled" }
  }
  if (order.status === "completed") {
    return { success: false, message: "Order is already completed" }
  }
  if (order.status === "cancelled") {
    return { success: false, message: "Cannot fulfill a cancelled order" }
  }

  // 3. Mark as in-flight — status → processing, fulfillment_status → pending
  await supabase
    .from("afa_orders")
    .update({
      fulfillment_status: "pending",
      status: "processing",
      fulfillment_attempts: (order.fulfillment_attempts || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderId)

  // 4. Call Sykes API
  const result = await registerAfaViaSykes({
    Full_Name: order.full_name || "",
    Ghana_Card_Number: order.gh_card_number || "",
    Occupation_type: order.occupation || "Farmer",
    Contact: order.phone_number || "",
    Location: order.location || "",
  })

  // 5. Update DB based on result
  if (result.success) {
    await supabase
      .from("afa_orders")
      .update({
        fulfillment_status: "fulfilled",
        fulfillment_ref: result.reference || null,
        fulfillment_error: null,
        fulfilled_at: new Date().toISOString(),
        status: "completed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", orderId)

    console.log("[AFA-FULFILL] Order fulfilled successfully:", orderId)
    return {
      success: true,
      message: result.message || "Registered successfully",
      fulfillmentRef: result.reference,
    }
  } else {
    await supabase
      .from("afa_orders")
      .update({
        fulfillment_status: "failed",
        fulfillment_error: result.message || "Unknown error",
        updated_at: new Date().toISOString(),
      })
      .eq("id", orderId)

    console.error("[AFA-FULFILL] Fulfillment failed:", orderId, result.message)
    return { success: false, message: result.message || "Fulfillment failed" }
  }
}

/**
 * Check whether AFA auto-fulfillment is currently enabled.
 */
export async function isAfaAutoFulfillmentEnabled(): Promise<boolean> {
  const supabase = getSupabase()

  const { data } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", "afa_auto_fulfillment_enabled")
    .maybeSingle()

  return data?.value?.enabled === true
}

export interface SubmitAfaOrderParams {
  userId: string
  fullName: string
  phoneNumber: string
  ghCardNumber: string
  location: string
  region: string
  occupation?: string
}

export interface SubmitAfaOrderResult {
  order: Record<string, any>
}

/**
 * Create and pay for an AFA registration order, then fire-and-forget the
 * Sykes registration if auto-fulfillment is on. Extracted from
 * app/api/afa/submit/route.ts so the dashboard route and the v1 API route
 * share one implementation. Always charges the server-side price from
 * afa_registration_prices — never a client-supplied amount.
 */
export async function submitAfaOrder(params: SubmitAfaOrderParams): Promise<SubmitAfaOrderResult> {
  const supabase = getSupabase()
  const { userId, fullName, phoneNumber, ghCardNumber, location, region, occupation } = params

  const { data: priceRow } = await supabase
    .from("afa_registration_prices")
    .select("price")
    .eq("is_active", true)
    .eq("name", "default")
    .maybeSingle()
  const afaPrice = priceRow?.price != null ? parseFloat(priceRow.price) : NaN
  if (!Number.isFinite(afaPrice) || afaPrice <= 0) {
    const err: any = new Error("AFA price unavailable, try again later")
    err.code = "PRICE_UNAVAILABLE"
    throw err
  }

  const { data: deductResult, error: deductError } = await supabase.rpc("deduct_wallet", {
    p_user_id: userId,
    p_amount: afaPrice,
  })
  if (deductError) {
    console.error("[AFA-FULFILL] Wallet deduction RPC error:", deductError)
    const err: any = new Error("Failed to process payment")
    err.code = "PAYMENT_FAILED"
    throw err
  }
  if (!deductResult || deductResult.length === 0) {
    const err: any = new Error("Insufficient balance")
    err.code = "INSUFFICIENT_BALANCE"
    err.required = afaPrice
    throw err
  }
  const { new_balance: newBalance, old_balance: balanceBefore } = deductResult[0]

  const orderCode = `AFA-${Date.now().toString().slice(-7)}`
  const transactionCode = secureString(10)

  const { data: afaOrder, error: afaError } = await supabase
    .from("afa_orders")
    .insert({
      user_id: userId,
      order_code: orderCode,
      transaction_code: transactionCode,
      full_name: fullName,
      phone_number: phoneNumber,
      gh_card_number: ghCardNumber,
      location,
      region,
      occupation,
      amount: afaPrice,
      status: "pending",
      created_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (afaError) {
    console.error("[AFA-FULFILL] Order creation failed, refunding wallet:", afaError)
    await supabase
      .from("wallets")
      .update({ balance: balanceBefore, total_spent: deductResult[0].new_total_spent - afaPrice, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
    const err: any = new Error("Failed to create AFA order")
    err.code = "ORDER_CREATE_FAILED"
    throw err
  }

  try {
    await sendSMS({ phone: phoneNumber, message: SMSTemplates.afaRegistration(fullName, orderCode, afaPrice.toString()), type: "afa_registration" })
  } catch (smsError) {
    console.warn("[AFA-FULFILL] Failed to send confirmation SMS:", smsError)
  }

  await supabase.from("transactions").insert({
    user_id: userId,
    type: "debit",
    amount: afaPrice,
    description: `AFA Registration - ${fullName}`,
    reference_id: transactionCode,
    source: "afa_registration",
    status: "completed",
    balance_before: balanceBefore,
    balance_after: newBalance,
    created_at: new Date().toISOString(),
  })

  try {
    const autoFulfill = await isAfaAutoFulfillmentEnabled()
    if (autoFulfill) {
      fulfillAfaOrder(afaOrder.id).catch((err) => {
        console.error("[AFA-FULFILL] Auto-fulfillment error for order", afaOrder.id, err)
      })
    }
  } catch (autoFulfillCheckError) {
    console.error("[AFA-FULFILL] Error checking auto-fulfillment setting:", autoFulfillCheckError)
  }

  return { order: afaOrder }
}
