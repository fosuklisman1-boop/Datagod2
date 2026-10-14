import { createClient } from "@supabase/supabase-js"
import { isDigiWapyConfigured, isDigiWapyEnabledForNetwork, sendAirtimeViaDigiwapy } from "@/lib/digiwapy-provider"
import { notifyAdmins, SMSTemplates } from "@/lib/sms-service"
import { type AirtimeOrderMinimal, fulfillAirtimeViaHubtel } from "@/lib/airtime-hubtel"
import { getAirtimeProvider, airtimeNetId, type AirtimeProvider } from "@/lib/airtime-provider"
import { airtimeEnabledKey, airtimeFeeKey, airtimeSettingsSuffix, legacyAirtimePrice } from "@/lib/airtime-fee"
import { airtimeCashbackTarget, type AirtimeProviderDeps } from "@/lib/cashback/storefront-airtime"
import { getCashbackConfig, type CashbackChannel } from "@/lib/cashback/config"
import { quoteCashback, samePrice, type CashbackQuote } from "@/lib/cashback/quote"
import { secureReference } from "@/lib/secure-random"
import { validateNetworkPrefix } from "@/lib/phone-format"
import { getPrefixValidationConfig } from "@/lib/network-prefix-config"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/** Manual path: nobody sends this order; alert the admins. Always returns false. */
async function alertManualAirtime(order: AirtimeOrderMinimal): Promise<boolean> {
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

/** Digiwapy path. Returns true when Digiwapy accepted the request, false otherwise. */
async function fulfillViaDigiwapy(order: AirtimeOrderMinimal): Promise<boolean> {
  // An explicit "digiwapy" setting skips the legacy per-network toggle but still needs the env.
  if (!isDigiWapyConfigured()) return alertManualAirtime(order)

  {
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
  }
}

/**
 * Single fulfilment chokepoint for every airtime surface (wallet, storefront Paystack, API v1, USSD).
 * Provider per network: explicit admin setting, else the legacy Digiwapy toggle. Never falls back
 * between providers automatically.
 * `resolvedProvider`: a provider already resolved for this order (cashback quote) — reused so the
 * snapshot provider and the sending provider are always the same.
 */
export async function triggerAirtimeFulfillment(
  order: AirtimeOrderMinimal,
  resolvedProvider?: AirtimeProvider,
): Promise<boolean> {
  try {
    const provider = resolvedProvider ?? await getAirtimeProvider(supabase, order.network, isDigiWapyEnabledForNetwork)
    console.log(`[AIRTIME-SVC] provider for ${order.network}: ${provider}`)
    if (provider === "digiwapy") return await fulfillViaDigiwapy(order)
    if (provider === "hubtel") {
      let rt: ReturnType<(typeof import("@/lib/hubtel-cs/runtime"))["getHubtelCsRuntime"]>
      try {
        const { getHubtelCsRuntime } = await import("@/lib/hubtel-cs/runtime")
        rt = getHubtelCsRuntime()
      } catch (e: any) {
        // Nothing was sent: hand to a human, never to another provider.
        console.error(`[AIRTIME-SVC] Hubtel runtime unavailable for order ${order.id}:`, e?.message ?? e)
        return await alertManualAirtime(order)
      }
      return await fulfillAirtimeViaHubtel(order, {
        purchase: input => rt.client.purchase(input),
        markOrder: async (orderId, patch, onlyFromStatuses) => {
          let q = supabase.from("airtime_orders")
            .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", orderId)
          if (onlyFromStatuses) {
            q = q.in("status", onlyFromStatuses)
          } else {
            q = q.neq("status", "completed")
          }
          const { data, error } = await q.select("id")
          if (error) throw error
          if (onlyFromStatuses && (data?.length ?? 0) === 0) {
            console.warn(`[AIRTIME-SVC] guarded write (${patch.status ?? "notes"}) matched 0 rows for order ${orderId}`)
          }
          return data?.length ?? 0
        },
        refreshTx: ref => rt.store.getByRef(ref),
        settle: async tx => { await rt.onTransition(tx) },
        alert: async (message, kind) => {
          await notifyAdmins(message, kind === "review" ? "airtime_hubtel_review" : "airtime_manual_needed", order.id, true)
        },
      })
    }
    return await alertManualAirtime(order)
  } catch (err: any) {
    console.error(`[AIRTIME-SVC] fulfilment dispatch threw for order ${order.id}:`, err?.message ?? err)
    return false
  }
}

/** @deprecated use triggerAirtimeFulfillment */
export const triggerDigiwapyFulfillment = triggerAirtimeFulfillment

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

  // Guarded flip: only the call whose update actually changed a row may go on to
  // profit / tracking / fulfilment, so a concurrent webhook + verify dispatches once.
  const { data: flipped, error: flipErr } = await supabase
    .from("airtime_orders")
    .update({
      payment_status: "completed",
      status: "pending",
      transaction_id: transactionId ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", airtimeData.id)
    .neq("payment_status", "completed")
    .select("id")

  if (flipErr) {
    console.error(`[AIRTIME-SVC] Failed to mark airtime order ${airtimeData.id} paid:`, flipErr)
    // The customer has paid but the order could not be marked paid, so it is not sent. Make sure a human sees it.
    notifyAdmins(
      `Airtime order ${airtimeData.reference_code} was PAID (txn ${transactionId ?? "?"}) but could not be marked paid - not sent. Check and fulfil or refund.`,
      "airtime_manual_needed",
      airtimeData.id,
      true
    ).catch(() => {})
    return { success: false }
  }
  if (!flipped || flipped.length === 0) {
    return { success: true, alreadyProcessed: true }
  }

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

  // Customer tracking — shop-scoped airtime purchases were never wired into
  // customerTrackingService, so they never showed up on the shop's Customers
  // dashboard. Non-blocking: must never break payment/fulfillment.
  if (airtimeData.shop_id) {
    try {
      const { customerTrackingService } = await import("./customer-tracking-service")
      await customerTrackingService.trackCustomer({
        shopId: airtimeData.shop_id,
        phoneNumber: airtimeData.beneficiary_phone,
        email: "",
        customerName: "Customer",
        totalPrice: Number(airtimeData.total_paid) || 0,
        slug: "storefront",
        orderId: airtimeData.id,
      })
    } catch (trackErr) {
      console.error("[AIRTIME-SVC] Customer tracking failed (non-fatal):", trackErr)
    }
  }

  await triggerAirtimeFulfillment({
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
  /** "AT" and "AirtelTigo" are the same network (stored as "AT"). */
  network: "MTN" | "AirtelTigo" | "AT" | "Telecel"
  beneficiaryPhone: string
  airtimeAmount: number
  paySeparately?: boolean
  shopId?: string | null
  /** Surface the purchase came from; decides whether the cashback surface switch applies. */
  channel: CashbackChannel
  /** Price the client was shown. With cashback applied, a mismatch throws PRICE_CHANGED before any debit. */
  expectedPay?: number
}

/** Live provider routing for cashback quotes (dashboard here, storefront routes via quoteStorefrontAirtime). */
export const airtimeProviderDeps: AirtimeProviderDeps = {
  getProvider: (network) => getAirtimeProvider(supabase, network, isDigiWapyEnabledForNetwork),
  digiwapyConfigured: () => isDigiWapyConfigured(),
}

/**
 * Instant-cashback quote for a non-shop purchase, or null when cashback is not applied.
 * Any failure (config read, provider read) means "not applied" — the legacy fee path runs.
 */
async function quoteAirtimeCashback(
  network: string,
  faceAmount: number,
  buyer: "customer" | "dealer",
  channel: CashbackChannel,
): Promise<(CashbackQuote & { airtimeProvider: AirtimeProvider }) | null> {
  try {
    if (!airtimeNetId(network)) return null
    const cfg = await getCashbackConfig(supabase)
    if (!cfg.enabled || !cfg.surfaces[channel]) return null
    // Digiwapy without its env goes to manual at fulfilment, and Hubtel rejects face above its per-request
    // cap after the debit: no commission would be earned, so no cashback. Legacy path, exactly as today.
    const target = await airtimeCashbackTarget(network, faceAmount, airtimeProviderDeps)
    if (!target) return null
    const q = quoteCashback({ serviceKey: target.serviceKey, provider: target.provider, faceAmount, buyer, channel }, cfg)
    return q.applied ? { ...q, airtimeProvider: target.provider } : null
  } catch (e: any) {
    console.warn("[AIRTIME-SVC] cashback quote unavailable, using standard pricing:", e?.message ?? e)
    return null
  }
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
 * Shared by the dashboard route and the v1 API route. Settings keys use the short network id
 * from airtimeNetId(): "MTN" -> mtn, "Telecel" -> telecel, "AT" and "AirtelTigo" -> at (the
 * keys that exist in production, the same ones lib/airtime-pricing.ts and the dashboard page read).
 * Both AT spellings are stored on the order as "AT".
 */
export async function purchaseAirtime(params: PurchaseAirtimeParams): Promise<PurchaseAirtimeResult> {
  const { userId, beneficiaryPhone, paySeparately = false, shopId, channel, expectedPay } = params
  const network = airtimeNetId(params.network) === "at" ? "AT" : params.network
  const cleanPhone = beneficiaryPhone.replace(/\s/g, "")
  const networkKey = airtimeSettingsSuffix(network)

  const enableSetting = await getAdminSetting(airtimeEnabledKey(network))
  if (enableSetting?.enabled === false) {
    const err: any = new Error(`Airtime for ${network} is currently unavailable`)
    err.code = "NETWORK_DISABLED"
    throw err
  }

  const { enabled: prefixCheckEnabled, map: prefixMap } = await getPrefixValidationConfig()
  if (prefixCheckEnabled) {
    const prefixCheck = validateNetworkPrefix(network, cleanPhone, prefixMap)
    if (!prefixCheck.ok) {
      const err: any = new Error(prefixCheck.message)
      err.code = "NETWORK_MISMATCH"
      throw err
    }
  }

  let merchantRoleFeeRate = 5
  let customMarkupRate = 0
  let isBuyerDealer = false

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
      const merchantFeeSetting = await getAdminSetting(airtimeFeeKey(network, isMerchantDealer ? "dealer" : "customer"))
      merchantRoleFeeRate = merchantFeeSetting?.rate ?? 5
    }
  } else {
    const { data: userProfile } = await supabase.from("users").select("role").eq("id", userId).single()
    const isUserDealer = userProfile?.role === "dealer" || userProfile?.role === "sub_agent"
    isBuyerDealer = isUserDealer
    const feeSetting = await getAdminSetting(airtimeFeeKey(network, isUserDealer ? "dealer" : "customer"))
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
  let feeAmount: number
  const merchantCommissionValue = 0

  // Instant cashback: non-shop purchases only. Not applied => the legacy fee path below, unchanged.
  const cashback = shopId
    ? null
    : await quoteAirtimeCashback(network, params.airtimeAmount, isBuyerDealer ? "dealer" : "customer", channel)

  if (cashback) {
    airtimeToRecipient = params.airtimeAmount
    totalPaid = cashback.payAmount
    feeAmount = 0
  } else {
    const legacy = legacyAirtimePrice(params.airtimeAmount, totalFeeRate, paySeparately)
    airtimeToRecipient = legacy.toRecipient
    totalPaid = legacy.total
    feeAmount = legacy.fee
  }

  // Price the client showed vs. what we'd charge now — on BOTH paths (e.g. cashback switched off after the
  // page loaded). Thrown before the duplicate check and any debit. No current caller omits => legacy unchanged.
  if (expectedPay !== undefined && !samePrice(expectedPay, totalPaid)) {
    const err: any = new Error("The price has changed. Please review the new price and try again.")
    err.code = "PRICE_CHANGED"
    err.quote = {
      faceAmount: params.airtimeAmount,
      payAmount: totalPaid,
      customerCashback: cashback ? cashback.customerCashback : 0,
      // The breakdown behind payAmount, so the client's fee/recipient lines add up after a 409.
      airtimeAmount: airtimeToRecipient,
      feeAmount,
      feeRate: cashback ? 0 : totalFeeRate,
    }
    throw err
  }

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
      pay_separately: cashback ? false : paySeparately,
      status: "pending",
      payment_status: "completed",
      shop_id: shopId || null,
      merchant_commission: merchantCommissionValue,
      ...(cashback
        ? {
            cashback_amount: cashback.customerCashback,
            shop_share_amount: 0,
            cashback_rate: cashback.rate,
            cashback_share: cashback.share,
            cashback_provider: cashback.provider,
            expected_commission: cashback.commission,
          }
        : {}),
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
    description: cashback
      ? `Airtime: ${network} GHS ${airtimeToRecipient} to ${cleanPhone} (cashback GHS ${cashback.customerCashback})`
      : `Airtime: ${network} GHS ${airtimeToRecipient} to ${cleanPhone}`,
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

  await triggerAirtimeFulfillment({
    id: order.id,
    reference_code: referenceCode,
    network,
    beneficiary_phone: cleanPhone,
    airtime_amount: airtimeToRecipient,
  }, cashback ? cashback.airtimeProvider : undefined)

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
