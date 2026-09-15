/**
 * AFA Fulfillment Helper
 *
 * Shared logic for fulfilling a single AFA order via Sykes or Apex Prime.
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
 * Which provider handles new AFA registrations right now. Read once per
 * order at submission time and frozen onto that row's fulfillment_provider
 * column — never re-derived later, so a later admin_settings change never
 * reinterprets an already-in-flight order under a different provider.
 */
export async function getAfaProviderSelection(): Promise<"sykes" | "apexprime"> {
  try {
    const supabase = getSupabase()
    const { data, error } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", "afa_provider_selection")
      .maybeSingle()
    if (error) {
      console.warn("[AFA-FULFILL] Error fetching provider setting:", error)
      return "sykes"
    }
    return data?.value?.provider === "apexprime" ? "apexprime" : "sykes"
  } catch (error) {
    console.error("[AFA-FULFILL] Error in getAfaProviderSelection:", error)
    return "sykes"
  }
}

/**
 * Submit an AFA order to Apex Prime. Unlike Sykes, this is genuinely async —
 * a successful submission leaves the order at fulfillment_status "pending" /
 * status "processing"; the sync-afa-status/apexprime cron confirms the real
 * outcome later via /status, once MTN approves or rejects the registration.
 */
async function fulfillAfaViaApexPrime(
  orderId: string,
  order: { full_name: string; gh_card_number: string; phone_number: string; location: string }
): Promise<FulfillResult> {
  const supabase = getSupabase()

  let result: { success: boolean; registrationId?: string | number; message: string }
  try {
    const { ApexPrimeProvider } = await import("@/lib/mtn-providers/apexprime-provider")
    result = await new ApexPrimeProvider().registerAfa({
      fullName: order.full_name || "",
      phoneNumber: order.phone_number || "",
      ghanaCardNumber: order.gh_card_number || "",
      location: order.location || "",
    })
  } catch (err) {
    console.error("[AFA-FULFILL] Apex Prime threw an exception:", err)
    result = { success: false, message: err instanceof Error ? err.message : "Apex Prime API error (exception)" }
  }

  if (result.success) {
    const { error: refWriteError } = await supabase
      .from("afa_orders")
      .update({
        fulfillment_ref: String(result.registrationId),
        fulfillment_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", orderId)
    if (refWriteError) {
      console.error("[AFA-FULFILL] CRITICAL: Apex Prime accepted the registration but failed to save fulfillment_ref — order will be invisible to the sync cron:", orderId, result.registrationId, refWriteError)
    }

    console.log("[AFA-FULFILL] Submitted to Apex Prime, awaiting confirmation:", orderId, result.registrationId)
    return { success: true, message: result.message, fulfillmentRef: String(result.registrationId) }
  }

  const { error: failWriteError } = await supabase
    .from("afa_orders")
    .update({
      fulfillment_status: "failed",
      fulfillment_error: result.message || "Unknown error",
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderId)
  if (failWriteError) {
    console.error("[AFA-FULFILL] Error saving Apex Prime failure status:", orderId, failWriteError)
  }

  console.error("[AFA-FULFILL] Apex Prime submission failed:", orderId, result.message)
  return { success: false, message: result.message || "Apex Prime submission failed" }
}

/**
 * Fulfill a single AFA order by ID.
 * - Fetches order data from DB
 * - Resolves the active provider (sykes or apexprime) and freezes it onto the row
 * - Calls that provider's registration API
 * - Updates afa_orders.fulfillment_status and related columns
 * - Sykes: sets afa_orders.status = "completed" on success (synchronous)
 * - Apex Prime: leaves status = "processing" on success (async — the sync
 *   cron confirms the real outcome later)
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
  if (order.fulfillment_status === "pending") {
    return { success: false, message: "Order already submitted, awaiting provider confirmation" }
  }
  if (order.status === "completed") {
    return { success: false, message: "Order is already completed" }
  }
  if (order.status === "cancelled") {
    return { success: false, message: "Cannot fulfill a cancelled order" }
  }

  // 3. Resolve provider (frozen onto the row now)
  const provider = await getAfaProviderSelection()

  // 4. Mark as in-flight — status → processing, fulfillment_status → pending.
  // The .in(...) clause makes this the atomic claim: only a row still at
  // "unfulfilled" or "failed" (the only states below besides "pending"/
  // "fulfilled") can be claimed, so two near-simultaneous calls for the same
  // order can't both proceed to submit to the provider.
  const { data: claimed, error: claimError } = await supabase
    .from("afa_orders")
    .update({
      fulfillment_status: "pending",
      status: "processing",
      fulfillment_attempts: (order.fulfillment_attempts || 0) + 1,
      fulfillment_provider: provider,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderId)
    .in("fulfillment_status", ["unfulfilled", "failed"])
    .select("id")

  if (claimError) {
    console.error("[AFA-FULFILL] Error claiming order for fulfillment:", orderId, claimError)
    return { success: false, message: "Failed to claim order for fulfillment" }
  }
  if (!claimed || claimed.length === 0) {
    return { success: false, message: "Order already submitted, completed, or cancelled" }
  }

  if (provider === "apexprime") {
    return fulfillAfaViaApexPrime(orderId, order)
  }

  // 5. Call Sykes API
  const result = await registerAfaViaSykes({
    Full_Name: order.full_name || "",
    Ghana_Card_Number: order.gh_card_number || "",
    Occupation_type: order.occupation || "Farmer",
    Contact: order.phone_number || "",
    Location: order.location || "",
  })

  // 6. Update DB based on result
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
