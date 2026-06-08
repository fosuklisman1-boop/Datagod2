import { createClient } from "@supabase/supabase-js"
import { isDigiWapyEnabledForNetwork, sendAirtimeViaDigiwapy } from "@/lib/digiwapy-provider"
import { notifyAdmins, SMSTemplates } from "@/lib/sms-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * Marks a paid airtime order ready for fulfillment and credits shop profit.
 *
 * Shared by the storefront webhook branch (resolved via wallet_payments) and the
 * USSD direct-charge webhook branch (resolved by id === reference). After marking
 * payment complete, attempts Digiwapy auto-fulfillment if enabled for the order's
 * network. On Digiwapy failure the order stays pending for admin retry.
 *
 * Idempotent: a duplicate webhook (payment already completed) is a no-op, and the
 * shop_profits insert tolerates the unique-violation (23505) from a re-credit.
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
      console.log(`[AIRTIME-SVC] ✓ Airtime profit recorded: GHS ${airtimeData.merchant_commission} (balance synced by DB trigger)`)
    }
  }

  // Attempt Digiwapy auto-fulfillment if enabled for this network
  try {
    const digiWapyEnabled = await isDigiWapyEnabledForNetwork(airtimeData.network)
    console.log(`[AIRTIME-SVC] Digiwapy enabled for ${airtimeData.network}: ${digiWapyEnabled}`)
    if (digiWapyEnabled) {
      const result = await sendAirtimeViaDigiwapy({
        network: airtimeData.network,
        recipient: airtimeData.beneficiary_phone,
        amount: airtimeData.airtime_amount,
        reference: airtimeData.reference_code,
      })
      if (result.success) {
        const dgwNote = result.digiwapyRef
          ? `Auto-fulfilled via Digiwapy [dgwRef:${result.digiwapyRef}]`
          : "Auto-fulfilled via Digiwapy"
        await supabase
          .from("airtime_orders")
          .update({
            status: "processing",
            notes: dgwNote,
            updated_at: new Date().toISOString(),
          })
          .eq("id", airtimeData.id)
        console.log(`[AIRTIME-SVC] ✓ Digiwapy auto-fulfill sent for order ${airtimeData.id} — dgwRef: ${result.digiwapyRef ?? "none"}`)
      } else {
        await supabase
          .from("airtime_orders")
          .update({
            notes: `Digiwapy error: ${result.message}`,
            updated_at: new Date().toISOString(),
          })
          .eq("id", airtimeData.id)
        console.warn(`[AIRTIME-SVC] Digiwapy auto-fulfill failed for order ${airtimeData.id}: ${result.message}`)
        notifyAdmins(
          SMSTemplates.adminAirtimeDigiwapyFailed(
            airtimeData.reference_code,
            airtimeData.network,
            airtimeData.beneficiary_phone,
            String(airtimeData.airtime_amount),
            result.message
          ),
          "airtime_digiwapy_failed",
          airtimeData.id,
          true // skip email fallback — SMS is enough
        ).catch(() => {})
      }
    } else {
      // Auto-fulfillment is off — admin must fulfil manually
      notifyAdmins(
        SMSTemplates.adminAirtimeManualRequired(
          airtimeData.reference_code,
          airtimeData.network,
          airtimeData.beneficiary_phone,
          String(airtimeData.airtime_amount)
        ),
        "airtime_manual_needed",
        airtimeData.id,
        true
      ).catch(() => {})
    }
  } catch (digiwapyErr: any) {
    console.error(`[AIRTIME-SVC] Digiwapy block threw for order ${airtimeData.id}:`, digiwapyErr?.message ?? digiwapyErr)
    // Don't let Digiwapy errors block payment confirmation — order stays pending for admin retry
  }

  return { success: true }
}
