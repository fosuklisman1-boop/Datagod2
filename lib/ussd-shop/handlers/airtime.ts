import { after } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { UzoResponse, USSDShopSession } from "../types"
import {
  cont, end, productMenu,
  shopAirtimeRecipientPrompt, shopAirtimeNetworkMenu, shopAirtimeAmountPrompt, shopAirtimeConfirmMenu, shopHeaderName,
} from "../menus"
import { setSession } from "../session"
import { networkNickname } from "@/lib/ussd/network-labels"
import { resolveEmail } from "@/lib/ussd/resolve-email"
import { chargeMobileMoney } from "@/lib/paystack"
import { paystackProviderFromPhone } from "@/lib/ussd/paystack-provider"
import { secureReference } from "@/lib/secure-random"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import {
  detectAirtimeNetwork, isAirtimeEnabled, getAirtimeLimits,
  airtimeBaseFeeRate, splitInclusive, airtimeNetworkKey,
} from "@/lib/airtime-pricing"
import { createShopAirtimeOrder } from "@/lib/shop-commerce/orders"
import { getUssdServiceVisibility } from "../../ussd-service-visibility"
import type { StorefrontQuote } from "@/lib/cashback/quote"
import {
  airtimeRequote, uzoAirtimeCashbackConfirm, uzoAirtimePromptCashback, uzoAirtimeQuote,
  uzoCashbackAirtimeColumns, uzoUsableAirtimeQuote, UZO_AIRTIME_AMOUNT_RE,
} from "@/lib/ussd/bots/airtime"
import { botErrorText } from "@/lib/ussd/bots/screen"

// Commission cashback (storefront split) needs the shop resolved at the code step (resolveShopCode,
// status 'active' only). No shop in the session => fail closed: today's pricing, never a quote.
const hasShop = (session: USSDShopSession): boolean => typeof session.shopId === "string" && session.shopId.length > 0

const promptCashback = (session: USSDShopSession, network: string, min: number): Promise<boolean> =>
  hasShop(session) ? uzoAirtimePromptCashback(network, min, true) : Promise.resolve(false)

function cashbackConfirmText(session: USSDShopSession, pay: number, face: number): string {
  return uzoAirtimeCashbackConfirm({
    header: shopHeaderName(session.shopName ?? "Shop"),
    label: networkNickname(session.airtimeNetwork!),
    recipient: toLocal(session.airtimeRecipient!),
    pay, face,
    payer: toLocal(session.dialingPhone!),
  })
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

function toLocal(phone: string): string {
  if (phone.startsWith("+233")) return "0" + phone.slice(4)
  if (phone.startsWith("233")) return "0" + phone.slice(3)
  return phone
}

async function getAdminSetting(key: string): Promise<any> {
  const { data } = await supabase.from("admin_settings").select("value").eq("key", key).single()
  return data?.value ?? null
}

async function shopOwnerIsDealer(shopId: string): Promise<boolean> {
  const { data: shop } = await supabase.from("user_shops").select("user_id").eq("id", shopId).single()
  if (!shop?.user_id) return false
  const { data: user } = await supabase.from("users").select("role").eq("id", shop.user_id).single()
  return user?.role === "dealer" || user?.role === "admin"
}

/**
 * Calculates the total fee rate and merchant commission for a shop airtime order.
 * base = platform's customer or dealer rate for the merchant.
 * markup = shop-level markup (from user_shops.airtime_markup_{network}).
 * Total cap: base + markup ≤ 10% (mirrors storefront rule).
 */
async function shopAirtimeFeeRate(
  shopId: string,
  network: string
): Promise<{ totalFeeRate: number; merchantCommissionRate: number }> {
  const isDealer = await shopOwnerIsDealer(shopId)
  const baseRate = await airtimeBaseFeeRate(network, isDealer)

  const { data: shop } = await supabase
    .from("user_shops")
    .select(`airtime_markup_${airtimeNetworkKey(network)}`)
    .eq("id", shopId)
    .single()

  const rawMarkup = parseFloat((shop as any)?.[`airtime_markup_${airtimeNetworkKey(network)}`] ?? 0) || 0
  const cappedMarkup = Math.max(0, Math.min(rawMarkup, 10 - baseRate))
  return { totalFeeRate: baseRate + cappedMarkup, merchantCommissionRate: cappedMarkup }
}

// ── SHOP_AIRTIME_ENTER_RECIPIENT ──────────────────────────────────────────────
export async function handleShopAirtimeEnterRecipient(
  input: string,
  sessionId: string,
  session: USSDShopSession
): Promise<UzoResponse> {
  const shopName = session.shopName ?? "Shop"
  if (input.trim() === "0") {
    await setSession(sessionId, { ...session, step: "SELECT_PRODUCT" })
    const adminVisibility = await getUssdServiceVisibility(supabase)
    return cont(productMenu(shopName, {
      data: adminVisibility.data,
      airtime: adminVisibility.airtime,
      resultsChecker: adminVisibility.resultsChecker,
    }))
  }

  const raw = input.trim().replace(/\s+/g, "")
  const local = toLocal(raw)
  if (!/^0[0-9]{9}$/.test(local)) {
    return cont("Invalid number.\n" + shopAirtimeRecipientPrompt(shopName))
  }

  const network = detectAirtimeNetwork(local)
  if (!network) {
    await setSession(sessionId, { ...session, step: "SHOP_AIRTIME_SELECT_NETWORK", airtimeRecipient: local })
    return cont(shopAirtimeNetworkMenu())
  }

  if (!(await isAirtimeEnabled(network))) {
    return cont(`${networkNickname(network)} airtime unavailable.\n` + shopAirtimeRecipientPrompt(shopName))
  }

  const { min, max } = await getAirtimeLimits()
  await setSession(sessionId, { ...session, step: "SHOP_AIRTIME_ENTER_AMOUNT", airtimeRecipient: local, airtimeNetwork: network })
  return cont(shopAirtimeAmountPrompt(networkNickname(network), min, max, await promptCashback(session, network, min)))
}

// ── SHOP_AIRTIME_SELECT_NETWORK (fallback) ────────────────────────────────────
export async function handleShopAirtimeSelectNetwork(
  input: string,
  sessionId: string,
  session: USSDShopSession
): Promise<UzoResponse> {
  const shopName = session.shopName ?? "Shop"
  if (input.trim() === "0") {
    await setSession(sessionId, { ...session, step: "SHOP_AIRTIME_ENTER_RECIPIENT" })
    return cont(shopAirtimeRecipientPrompt(shopName))
  }

  const map: Record<string, "MTN" | "Telecel" | "AT"> = { "1": "MTN", "2": "Telecel", "3": "AT" }
  const network = map[input.trim()]
  if (!network) return cont(shopAirtimeNetworkMenu())

  if (!(await isAirtimeEnabled(network))) {
    return cont(`${networkNickname(network)} airtime unavailable.\n` + shopAirtimeNetworkMenu())
  }

  const { min, max } = await getAirtimeLimits()
  await setSession(sessionId, { ...session, step: "SHOP_AIRTIME_ENTER_AMOUNT", airtimeNetwork: network })
  return cont(shopAirtimeAmountPrompt(networkNickname(network), min, max, await promptCashback(session, network, min)))
}

// ── SHOP_AIRTIME_ENTER_AMOUNT ─────────────────────────────────────────────────
export async function handleShopAirtimeEnterAmount(
  input: string,
  sessionId: string,
  session: USSDShopSession
): Promise<UzoResponse> {
  const shopName = session.shopName ?? "Shop"
  if (input.trim() === "0") {
    await setSession(sessionId, { ...session, step: "SHOP_AIRTIME_ENTER_RECIPIENT" })
    return cont(shopAirtimeRecipientPrompt(shopName))
  }

  const amount = parseFloat(input.trim())
  const network = session.airtimeNetwork!
  const { min, max } = await getAirtimeLimits()
  if (isNaN(amount) || amount < min || amount > max) {
    return cont(`Enter a valid amount.\n` + shopAirtimeAmountPrompt(networkNickname(network), min, max, await promptCashback(session, network, min)))
  }

  // Commission cashback (storefront split). Applied => the typed amount is the face delivered and the
  // shop earns its cashback share (no markup).
  const cb = hasShop(session) ? await uzoUsableAirtimeQuote(network, amount, true) : null
  if (cb) {
    // The face is delivered as typed: at most 2 decimals, digits only (today's path keeps its parse).
    if (!UZO_AIRTIME_AMOUNT_RE.test(input.trim())) {
      return cont(`Enter a valid amount.\n` + shopAirtimeAmountPrompt(networkNickname(network), min, max, true))
    }
    const next: USSDShopSession = {
      ...session,
      step: "SHOP_AIRTIME_CONFIRM",
      airtimeAmount: amount,
      airtimeFee: 0,
      airtimeToDeliver: amount,
      airtimeMerchantCommission: cb.shopShare,
      airtimeCashbackPay: cb.payAmount,
    }
    await setSession(sessionId, next)
    return cont(cashbackConfirmText(next, cb.payAmount, amount))
  }

  // Not applied: today's shop markup pricing, unchanged.
  const { totalFeeRate, merchantCommissionRate } = await shopAirtimeFeeRate(session.shopId!, network)
  const { fee, toDeliver } = splitInclusive(amount, totalFeeRate)
  const commission = parseFloat((toDeliver * merchantCommissionRate / 100).toFixed(2))

  await setSession(sessionId, {
    ...session,
    step: "SHOP_AIRTIME_CONFIRM",
    airtimeAmount: amount,
    airtimeFee: fee,
    airtimeToDeliver: toDeliver,
    airtimeMerchantCommission: commission,
    ...(session.airtimeCashbackPay !== undefined ? { airtimeCashbackPay: undefined } : {}),
  })
  return cont(shopAirtimeConfirmMenu(shopName, networkNickname(network), session.airtimeRecipient!, amount, toDeliver, session.dialingPhone!))
}

// ── SHOP_AIRTIME_CONFIRM ──────────────────────────────────────────────────────
export async function handleShopAirtimeConfirm(
  input: string,
  sessionId: string,
  session: USSDShopSession
): Promise<UzoResponse> {
  const shopName = session.shopName ?? "Shop"
  if (input.trim() === "2" || input.trim() === "0") return end("Order cancelled.")
  if (input.trim() !== "1") {
    if (session.airtimeCashbackPay !== undefined) {
      return cont(cashbackConfirmText(session, session.airtimeCashbackPay, session.airtimeAmount!))
    }
    return cont(shopAirtimeConfirmMenu(
      shopName, networkNickname(session.airtimeNetwork!), session.airtimeRecipient!,
      session.airtimeAmount!, session.airtimeToDeliver!, session.dialingPhone!
    ))
  }

  const network = session.airtimeNetwork!
  const dialingPhone = session.dialingPhone!

  // Re-verify settings server-side
  if (!(await isAirtimeEnabled(network))) return end(`${networkNickname(network)} airtime is no longer available.`)
  const { min, max } = await getAirtimeLimits()
  const amount = session.airtimeAmount!
  if (amount < min || amount > max) return end(`Amount must be GHS ${min}-${max}. Please restart.`)

  const provider = paystackProviderFromPhone(dialingPhone)
  if (!provider) return end("Payment not available for your number.")

  // Cashback re-quote: the screen and the live quote must agree on the pricing mode AND the price;
  // otherwise no order is created and the caller restarts. No shop => never cashback (fail closed).
  let cb: StorefrontQuote | null = null
  if (hasShop(session)) {
    const rq = airtimeRequote(session.airtimeCashbackPay, await uzoAirtimeQuote(network, amount, true), amount)
    if (rq.kind === "changed") return end(botErrorText(409))
    if (rq.kind === "cashback") cb = rq.quote
  }

  const referenceCode = secureReference("AT", 2, 3)
  let orderResult: Awaited<ReturnType<typeof createShopAirtimeOrder>>
  if (cb) {
    // Applied: face delivered, total_paid = payAmount, merchant_commission = the shop's cashback share
    // (credited once to shop_id by markAirtimeOrderPaid after payment), no markup.
    orderResult = await createShopAirtimeOrder({
      referenceCode,
      network,
      beneficiaryPhone: session.airtimeRecipient!,
      airtimeAmount: amount,
      feeAmount: 0, // the Paystack fee lives in payment_fee_amount only
      totalPaid: cb.payAmount,
      shopId: session.shopId!,
      merchantCommission: cb.shopShare,
      dialingPhone,
      channel: "ussd_shop",
      cashbackColumns: uzoCashbackAirtimeColumns(cb, true),
    })
  } else {
    const { totalFeeRate, merchantCommissionRate } = await shopAirtimeFeeRate(session.shopId!, network)
    const { fee, toDeliver } = splitInclusive(amount, totalFeeRate)
    const commission = parseFloat((toDeliver * merchantCommissionRate / 100).toFixed(2))
    orderResult = await createShopAirtimeOrder({
      referenceCode,
      network,
      beneficiaryPhone: session.airtimeRecipient!,
      airtimeAmount: toDeliver,
      feeAmount: fee,
      totalPaid: amount,
      shopId: session.shopId!,
      merchantCommission: commission,
      dialingPhone,
      channel: "ussd_shop",
    })
  }
  // What the caller is charged = the row's total_paid.
  const price = cb ? cb.payAmount : amount

  if ("error" in orderResult) {
    console.error("[USSD-SHOP-AIRTIME] Failed to create order:", orderResult.error)
    return end("Error creating order.\nPlease try again.")
  }
  const orderId = orderResult.orderId

  const email = await resolveEmail(dialingPhone)
  const localDialing = toLocal(dialingPhone)

  after(async () => {
    await new Promise(r => setTimeout(r, 3000))
    try {
      const { status } = await chargeMobileMoney({
        email,
        amount: price,
        phone: dialingPhone,
        provider,
        reference: orderId,
        metadata: {
          source: "ussd_shop_airtime",
          airtime_order_id: orderId,
          recipient_phone: session.airtimeRecipient,
          network,
          shop_id: session.shopId,
        },
      })
      try {
        await supabase.from("payment_attempts").insert({
          reference: orderId, amount: price, email,
          status: "pending", payment_type: "ussd_shop_airtime", order_id: orderId,
        })
      } catch (paErr) {
        console.warn("[USSD-SHOP-AIRTIME] payment_attempts insert failed (non-fatal):", paErr)
      }
      console.log("[USSD-SHOP-AIRTIME] ✓ Charge initiated:", orderId, "status:", status)
      if (status === "send_otp") {
        await supabase.from("airtime_orders")
          .update({ payment_status: "otp_required", updated_at: new Date().toISOString() })
          .eq("id", orderId)
        sendSMS({ phone: dialingPhone, message: SMSTemplates.ussdOtpRequired(), type: "otp_required", reference: orderId }).catch(() => {})
      }
    } catch (err) {
      console.error("[USSD-SHOP-AIRTIME] Charge failed:", err)
      await supabase.from("airtime_orders")
        .update({ payment_status: "failed", status: "failed", updated_at: new Date().toISOString() })
        .eq("id", orderId)
    }
  })

  await setSession(sessionId, {
    ...session,
    pendingOrderId: orderId,
    pendingOrderTable: "airtime_orders",
    step: "ENTER_SHOP_CODE",
  })
  return end(`MoMo prompt sent to ${localDialing}. Approve to complete.\n\nReceived an OTP instead? Redial and enter the code.`)
}
