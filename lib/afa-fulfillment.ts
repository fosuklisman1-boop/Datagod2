/**
 * AFA Fulfillment Helper
 *
 * Shared logic for fulfilling a single AFA order via the Sykes API.
 * Imported by both the submit route (auto-fulfillment) and the admin
 * fulfillment endpoint (manual / bulk trigger).
 */

import { createClient } from "@supabase/supabase-js"
import { registerAfaViaSykes } from "@/lib/sykes-afa-provider"

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

  // 2. Guard: skip already-fulfilled or cancelled orders
  if (order.fulfillment_status === "fulfilled") {
    return { success: false, message: "Order already fulfilled" }
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
