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
  if (order.order_status === "completed") {
    return { success: false, message: "Already completed" }
  }

  const provider = await getAfaProviderSelection()

  await supabase
    .from("ussd_afa_orders")
    .update({
      order_status: "processing",
      fulfillment_status: "pending",
      fulfillment_provider: provider,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderId)

  if (provider === "apexprime") {
    const { ApexPrimeProvider } = await import("@/lib/mtn-providers/apexprime-provider")
    const result = await new ApexPrimeProvider().registerAfa({
      fullName: order.full_name,
      phoneNumber: order.dialing_phone,
      ghanaCardNumber: order.gh_card_number,
      location: order.location,
    })

    if (result.success) {
      await supabase
        .from("ussd_afa_orders")
        .update({
          fulfillment_ref: String(result.registrationId),
          fulfillment_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", orderId)
      console.log("[USSD-AFA-FULFILL] Submitted to Apex Prime, awaiting confirmation:", orderId, result.registrationId)
      return { success: true, message: "AFA registration submitted, awaiting confirmation" }
    }

    await supabase
      .from("ussd_afa_orders")
      .update({
        fulfillment_status: "failed",
        fulfillment_error: result.message || "Unknown error",
        updated_at: new Date().toISOString(),
      })
      .eq("id", orderId)
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
