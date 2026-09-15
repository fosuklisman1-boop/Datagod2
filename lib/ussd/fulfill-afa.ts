import { createClient } from "@supabase/supabase-js"
import { registerAfaViaSykes } from "@/lib/sykes-afa-provider"
import { getAfaProviderSelection } from "@/lib/afa-fulfillment"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function fulfillUssdAfaOrder(orderId: string): Promise<{ success: boolean; message: string }> {
  console.log("[USSD-AFA-FULFILL] Starting fulfillment:", orderId)

  const { data: order, error: fetchErr } = await supabase
    .from("ussd_afa_orders")
    .select("id, full_name, gh_card_number, location, region, occupation, dialing_phone, fulfillment_status, order_status")
    .eq("id", orderId)
    .single()

  if (fetchErr || !order) {
    console.error("[USSD-AFA-FULFILL] Order not found:", orderId, fetchErr)
    return { success: false, message: "Order not found" }
  }

  if (order.fulfillment_status === "fulfilled") {
    return { success: false, message: "Already fulfilled" }
  }
  if (order.fulfillment_status === "pending") {
    return { success: false, message: "Order already submitted, awaiting provider confirmation" }
  }
  if (order.order_status === "completed") {
    return { success: false, message: "Already completed" }
  }

  const provider = await getAfaProviderSelection()

  // Atomic claim — only a row still at "unfulfilled" or "failed" can be
  // claimed here, so two near-simultaneous calls for the same order can't
  // both proceed to submit to the provider.
  const { data: claimed, error: claimError } = await supabase
    .from("ussd_afa_orders")
    .update({
      order_status: "processing",
      fulfillment_status: "pending",
      fulfillment_provider: provider,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderId)
    .in("fulfillment_status", ["unfulfilled", "failed"])
    .select("id")

  if (claimError) {
    console.error("[USSD-AFA-FULFILL] Error claiming order for fulfillment:", orderId, claimError)
    return { success: false, message: "Failed to claim order for fulfillment" }
  }
  if (!claimed || claimed.length === 0) {
    return { success: false, message: "Order already submitted, completed, or cancelled" }
  }

  if (provider === "apexprime") {
    let result: { success: boolean; registrationId?: string | number; message: string }
    try {
      const { ApexPrimeProvider } = await import("@/lib/mtn-providers/apexprime-provider")
      result = await new ApexPrimeProvider().registerAfa({
        fullName: order.full_name,
        phoneNumber: order.dialing_phone,
        ghanaCardNumber: order.gh_card_number,
        location: order.location,
      })
    } catch (err) {
      console.error("[USSD-AFA-FULFILL] Apex Prime threw an exception:", err)
      result = { success: false, message: err instanceof Error ? err.message : "Apex Prime API error (exception)" }
    }

    if (result.success) {
      const { error: refWriteError } = await supabase
        .from("ussd_afa_orders")
        .update({
          fulfillment_ref: String(result.registrationId),
          fulfillment_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", orderId)
      if (refWriteError) {
        console.error("[USSD-AFA-FULFILL] CRITICAL: Apex Prime accepted the registration but failed to save fulfillment_ref — order will be invisible to the sync cron:", orderId, result.registrationId, refWriteError)
      }
      console.log("[USSD-AFA-FULFILL] Submitted to Apex Prime, awaiting confirmation:", orderId, result.registrationId)
      return { success: true, message: "AFA registration submitted, awaiting confirmation" }
    }

    const { error: failWriteError } = await supabase
      .from("ussd_afa_orders")
      .update({
        fulfillment_status: "failed",
        fulfillment_error: result.message || "Unknown error",
        updated_at: new Date().toISOString(),
      })
      .eq("id", orderId)
    if (failWriteError) {
      console.error("[USSD-AFA-FULFILL] Error saving Apex Prime failure status:", orderId, failWriteError)
    }
    console.error("[USSD-AFA-FULFILL] Apex Prime submission failed:", orderId, result.message)
    return { success: false, message: result.message || "Apex Prime submission failed" }
  }

  const result = await registerAfaViaSykes({
    Full_Name: order.full_name,
    Ghana_Card_Number: order.gh_card_number,
    Occupation_type: order.occupation || "Farmer",
    Contact: order.dialing_phone,
    Location: order.location,
  })

  await supabase
    .from("ussd_afa_orders")
    .update({
      fulfillment_attempts: (order.fulfillment_status === "failed" ? 1 : 0) + 1,
      updated_at: new Date().toISOString(),
      ...(result.success
        ? {
            fulfillment_status: "fulfilled",
            order_status: "completed",
            fulfillment_ref: result.reference ?? null,
            fulfillment_error: null,
            fulfilled_at: new Date().toISOString(),
          }
        : {
            fulfillment_status: "failed",
            order_status: "pending",
            fulfillment_error: result.message ?? "Unknown error",
          }),
    })
    .eq("id", orderId)

  if (result.success) {
    console.log("[USSD-AFA-FULFILL] ✓ Fulfilled:", orderId, "ref:", result.reference)
    return { success: true, message: "AFA registration submitted successfully" }
  }

  console.error("[USSD-AFA-FULFILL] Fulfillment failed:", orderId, result.message)
  return { success: false, message: result.message ?? "Fulfillment failed" }
}
