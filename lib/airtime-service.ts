import { createClient } from "@supabase/supabase-js"
import { isDigiWapyEnabledForNetwork, sendAirtimeViaDigiwapy } from "@/lib/digiwapy-provider"
import { notifyAdmins, SMSTemplates } from "@/lib/sms-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

interface AirtimeOrderMinimal {
  id: string
  reference_code: string
  network: string
  beneficiary_phone: string
  airtime_amount: number
}

/**
 * Attempt Digiwapy auto-fulfillment for a paid airtime order.
 * Safe to call from any payment path (webhook or wallet).
 * Returns true when Digiwapy accepted the request, false otherwise.
 */
export async function triggerDigiwapyFulfillment(order: AirtimeOrderMinimal): Promise<boolean> {
  try {
    const digiWapyEnabled = await isDigiWapyEnabledForNetwork(order.network)
    console.log(`[AIRTIME-SVC] Digiwapy enabled for ${order.network}: ${digiWapyEnabled}`)

    if (!digiWapyEnabled) {
      notifyAdmins(
        SMSTemplates.adminAirtimeManualRequired(
          order.reference_code,
          order.network,
          order.beneficiary_phone,
          String(order.airtime_amount)
        ),
        "airtime_manual_needed",
        order.id,
        true
      ).catch(() => {})
      return false
    }

    const result = await sendAirtimeViaDigiwapy({
      network: order.network,
      recipient: order.beneficiary_phone,
      amount: order.airtime_amount,
      reference: order.reference_code,
    })

    if (result.success) {
      const dgwNote = result.digiwapyRef
        ? `Auto-fulfilled via Digiwapy [dgwRef:${result.digiwapyRef}]`
        : "Auto-fulfilled via Digiwapy"
      await supabase
        .from("airtime_orders")
        .update({ status: "processing", notes: dgwNote, updated_at: new Date().toISOString() })
        .eq("id", order.id)
      console.log(`[AIRTIME-SVC] ✓ Digiwapy sent for order ${order.id} — dgwRef: ${result.digiwapyRef ?? "none"}`)
      return true
    } else {
      await supabase
        .from("airtime_orders")
        .update({ notes: `Digiwapy error: ${result.message}`, updated_at: new Date().toISOString() })
        .eq("id", order.id)
      console.warn(`[AIRTIME-SVC] Digiwapy failed for order ${order.id}: ${result.message}`)
      notifyAdmins(
        SMSTemplates.adminAirtimeDigiwapyFailed(
          order.reference_code,
          order.network,
          order.beneficiary_phone,
          String(order.airtime_amount),
          result.message
        ),
        "airtime_digiwapy_failed",
        order.id,
        true
      ).catch(() => {})
      return false
    }
  } catch (err: any) {
    console.error(`[AIRTIME-SVC] Digiwapy block threw for order ${order.id}:`, err?.message ?? err)
    return false
  }
}

/**
 * Marks a Paystack-paid airtime order as paid and triggers Digiwapy fulfillment.
 * Idempotent — duplicate webhooks are no-ops.
 */
export async function markAirtimeOrderPaid(
  orderId: string,
  transactionId?: string | number | null
): Promise<{ success: boolean; alreadyProcessed?: boolean }> {
  const { data: airtimeData } = await supabase
    .from("airtime_orders")
    .select("*")
    .eq("id", orderId)
    .single()

  if (!airtimeData) return { success: false }

  if (airtimeData.payment_status === "completed") {
    return { success: true, alreadyProcessed: true }
  }

  await supabase
    .from("airtime_orders")
    .update({
      payment_status: "completed",
      status: "pending",
      transaction_id: transactionId ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", airtimeData.id)

  if (airtimeData.merchant_commission > 0 && airtimeData.shop_id) {
    const { error: profitErr } = await supabase.from("shop_profits").insert([{
      shop_id: airtimeData.shop_id,
      airtime_order_id: airtimeData.id,
      profit_amount: airtimeData.merchant_commission,
      status: "credited",
      created_at: new Date().toISOString(),
    }])
    if (profitErr && profitErr.code !== "23505") {
      console.error("[AIRTIME-SVC] Failed to insert airtime profit record:", profitErr)
    } else if (!profitErr) {
      console.log(`[AIRTIME-SVC] ✓ Airtime profit recorded: GHS ${airtimeData.merchant_commission}`)
    }
  }

  await triggerDigiwapyFulfillment({
    id: airtimeData.id,
    reference_code: airtimeData.reference_code,
    network: airtimeData.network,
    beneficiary_phone: airtimeData.beneficiary_phone,
    airtime_amount: airtimeData.airtime_amount,
  })

  return { success: true }
}
