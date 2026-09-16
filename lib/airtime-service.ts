import { createClient } from "@supabase/supabase-js"
import { isDigiWapyEnabledForNetwork, sendAirtimeViaDigiwapy } from "@/lib/digiwapy-provider"
import { notifyAdmins, SMSTemplates } from "@/lib/sms-service"
import { secureReference } from "@/lib/secure-random"

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

async function getAdminSetting(key: string): Promise<any> {
  const { data } = await supabase.from("admin_settings").select("value").eq("key", key).single()
  return data?.value ?? null
}

export interface PurchaseAirtimeParams {
  userId: string
  network: "MTN" | "AirtelTigo" | "Telecel"
  beneficiaryPhone: string
  airtimeAmount: number
  paySeparately?: boolean
  shopId?: string | null
}

export interface PurchaseAirtimeResult {
  order: {
    id: string
    reference_code: string
    network: string
    beneficiary_phone: string
    airtime_amount: number
    fee_amount: number
    total_paid: number
    status: string
  }
  newBalance: number
}

/**
 * Buy airtime for a beneficiary phone, deducting the buyer's wallet.
 * Extracted from app/api/airtime/purchase/route.ts so the dashboard route and
 * the v1 API route share one implementation. Preserves that route's exact
 * network-key convention ("AirtelTigo" → admin_settings key suffix
 * "airteltigo") — do NOT swap in lib/airtime-pricing.ts's helpers here, they
 * use a different network vocabulary ("AT") that reads a different key.
 */
export async function purchaseAirtime(params: PurchaseAirtimeParams): Promise<PurchaseAirtimeResult> {
  const { userId, network, beneficiaryPhone, paySeparately = false, shopId } = params
  const cleanPhone = beneficiaryPhone.replace(/\s/g, "")
  const networkKey = network.toLowerCase().replace(/\s/g, "_")

  const enableSetting = await getAdminSetting(`airtime_enabled_${networkKey}`)
  if (enableSetting?.enabled === false) {
    const err: any = new Error(`Airtime for ${network} is currently unavailable`)
    err.code = "NETWORK_DISABLED"
    throw err
  }

  let merchantRoleFeeRate = 5
  let customMarkupRate = 0

  if (shopId) {
    const { data: shop } = await supabase
      .from("user_shops")
      .select("user_id, airtime_markup_mtn, airtime_markup_telecel, airtime_markup_at")
      .eq("id", shopId)
      .single()

    if (shop) {
      const merchantUserId = shop.user_id
      if (merchantUserId !== userId) {
        customMarkupRate = parseFloat(shop[`airtime_markup_${networkKey}` as keyof typeof shop] as string) || 0
      }
      const { data: merchantProfile } = await supabase.from("users").select("role").eq("id", merchantUserId).single()
      const isMerchantDealer = merchantProfile?.role === "dealer"
      const merchantFeeKey = isMerchantDealer ? `airtime_fee_${networkKey}_dealer` : `airtime_fee_${networkKey}_customer`
      const merchantFeeSetting = await getAdminSetting(merchantFeeKey)
      merchantRoleFeeRate = merchantFeeSetting?.rate ?? 5
    }
  } else {
    const { data: userProfile } = await supabase.from("users").select("role").eq("id", userId).single()
    const isUserDealer = userProfile?.role === "dealer" || userProfile?.role === "sub_agent"
    const feeKey = isUserDealer ? `airtime_fee_${networkKey}_dealer` : `airtime_fee_${networkKey}_customer`
    const feeSetting = await getAdminSetting(feeKey)
    merchantRoleFeeRate = feeSetting?.rate ?? 5
  }

  const totalFeeRate = merchantRoleFeeRate + customMarkupRate

  const minSetting = await getAdminSetting("airtime_min_amount")
  const maxSetting = await getAdminSetting("airtime_max_amount")
  const minAmount = minSetting?.amount ?? 1
  const maxAmount = maxSetting?.amount ?? 500
  if (params.airtimeAmount < minAmount) {
    const err: any = new Error(`Minimum airtime amount is GHS ${minAmount}`)
    err.code = "INVALID_AMOUNT"
    throw err
  }
  if (params.airtimeAmount > maxAmount) {
    const err: any = new Error(`Maximum airtime amount is GHS ${maxAmount}`)
    err.code = "INVALID_AMOUNT"
    throw err
  }

  let airtimeToRecipient: number
  let totalPaid: number
  const merchantCommissionValue = 0

  if (paySeparately) {
    airtimeToRecipient = params.airtimeAmount
    const totalFeeAmount = parseFloat((params.airtimeAmount * totalFeeRate / 100).toFixed(2))
    totalPaid = parseFloat((params.airtimeAmount + totalFeeAmount).toFixed(2))
  } else {
    totalPaid = params.airtimeAmount
    const totalFeeAmount = parseFloat((params.airtimeAmount * totalFeeRate / (100 + totalFeeRate)).toFixed(2))
    airtimeToRecipient = parseFloat((totalPaid - totalFeeAmount).toFixed(2))
  }
  const feeAmount = parseFloat((totalPaid - airtimeToRecipient).toFixed(2))

  const thirtySecondsAgo = new Date(Date.now() - 30_000).toISOString()
  const { data: recentOrder } = await supabase
    .from("airtime_orders")
    .select("id, reference_code")
    .eq("user_id", userId)
    .eq("beneficiary_phone", cleanPhone)
    .eq("airtime_amount", airtimeToRecipient)
    .neq("status", "failed")
    .gte("created_at", thirtySecondsAgo)
    .maybeSingle()

  if (recentOrder) {
    const err: any = new Error("Duplicate request detected. Please wait before trying again.")
    err.code = "DUPLICATE_REQUEST"
    err.reference = recentOrder.reference_code
    throw err
  }

  const { data: deductResult, error: deductError } = await supabase.rpc("deduct_wallet", {
    p_user_id: userId,
    p_amount: totalPaid,
  })
  if (deductError) {
    console.error("[AIRTIME-SVC] Wallet deduction RPC error:", deductError)
    const err: any = new Error("Failed to process payment")
    err.code = "PAYMENT_FAILED"
    throw err
  }
  if (!deductResult || deductResult.length === 0) {
    const err: any = new Error("Insufficient wallet balance")
    err.code = "INSUFFICIENT_BALANCE"
    err.required = totalPaid
    throw err
  }
  const { new_balance: newBalance, old_balance: balanceBefore } = deductResult[0]

  const referenceCode = secureReference("AT", 2, 3)
  const { data: order, error: orderError } = await supabase
    .from("airtime_orders")
    .insert([{
      user_id: userId,
      reference_code: referenceCode,
      network,
      beneficiary_phone: cleanPhone,
      airtime_amount: airtimeToRecipient,
      fee_amount: feeAmount,
      total_paid: totalPaid,
      pay_separately: paySeparately,
      status: "pending",
      payment_status: "completed",
      shop_id: shopId || null,
      merchant_commission: merchantCommissionValue,
    }])
    .select()
    .single()

  if (orderError || !order) {
    console.error("[AIRTIME-SVC] Order creation failed, refunding wallet:", orderError)
    await supabase
      .from("wallets")
      .update({ balance: balanceBefore, total_spent: deductResult[0].new_total_spent - totalPaid, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
    const err: any = new Error("Failed to create order. Wallet refunded.")
    err.code = "ORDER_CREATE_FAILED"
    throw err
  }

  await supabase.from("transactions").insert([{
    user_id: userId,
    type: "debit",
    source: "airtime_purchase",
    amount: totalPaid,
    balance_before: balanceBefore,
    balance_after: newBalance,
    description: `Airtime: ${network} GHS ${airtimeToRecipient} to ${cleanPhone}`,
    reference_id: order.id,
    status: "completed",
    created_at: new Date().toISOString(),
  }])

  await supabase.from("notifications").insert([{
    user_id: userId,
    title: "Airtime Order Placed",
    message: `Your GHS ${airtimeToRecipient} ${network} airtime order for ${cleanPhone} is pending. Ref: ${referenceCode}`,
    type: "order_update",
    reference_id: order.id,
    action_url: `/dashboard/airtime`,
    read: false,
  }])

  await triggerDigiwapyFulfillment({
    id: order.id,
    reference_code: referenceCode,
    network,
    beneficiary_phone: cleanPhone,
    airtime_amount: airtimeToRecipient,
  })

  try {
    const { data: shopData } = order.shop_id
      ? await supabase.from("user_shops").select("shop_name").eq("id", order.shop_id).single()
      : { data: null }
    const shopName = shopData?.shop_name || "Direct"
    Promise.allSettled([
      import("@/lib/email-service").then(({ sendEmail, EmailTemplates }) => {
        const payload = EmailTemplates.airtimeAdminAlert(referenceCode, network, cleanPhone, airtimeToRecipient.toFixed(2), totalPaid.toFixed(2))
        return sendEmail({ to: [], subject: payload.subject, htmlContent: payload.html, referenceId: order.id, type: "airtime_admin_alert" })
      }).catch((e) => console.warn("[AIRTIME-SVC] Admin email error:", e)),
    ]).catch((e) => console.warn("[AIRTIME-SVC] Non-blocking notification error:", e))
  } catch (notifErr) {
    console.warn("[AIRTIME-SVC] Notification preparation error:", notifErr)
  }

  return {
    order: {
      id: order.id,
      reference_code: referenceCode,
      network,
      beneficiary_phone: cleanPhone,
      airtime_amount: airtimeToRecipient,
      fee_amount: feeAmount,
      total_paid: totalPaid,
      status: "pending",
    },
    newBalance,
  }
}
