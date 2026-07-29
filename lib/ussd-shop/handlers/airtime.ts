import { after } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { UzoResponse, USSDShopSession } from "../types"
import {
  cont, end, productMenu,
  shopAirtimeRecipientPrompt, shopAirtimeNetworkMenu, shopAirtimeAmountPrompt, shopAirtimeConfirmMenu,
} from "../menus"
import { setSession } from "../session"
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
    return cont(productMenu(shopName))
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
    return cont(`${network} airtime unavailable.\n` + shopAirtimeRecipientPrompt(shopName))
  }

  const { min, max } = await getAirtimeLimits()
  await setSession(sessionId, { ...session, step: "SHOP_AIRTIME_ENTER_AMOUNT", airtimeRecipient: local, airtimeNetwork: network })
  return cont(shopAirtimeAmountPrompt(network, min, max))
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
    return cont(`${network} airtime unavailable.\n` + shopAirtimeNetworkMenu())
  }

  const { min, max } = await getAirtimeLimits()
  await setSession(sessionId, { ...session, step: "SHOP_AIRTIME_ENTER_AMOUNT", airtimeNetwork: network })
  return cont(shopAirtimeAmountPrompt(network, min, max))
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
    return cont(`Enter a valid amount.\n` + shopAirtimeAmountPrompt(network, min, max))
  }

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
  })
  return cont(shopAirtimeConfirmMenu(shopName, network, session.airtimeRecipient!, amount, toDeliver, session.dialingPhone!))
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
    return cont(shopAirtimeConfirmMenu(
      shopName, session.airtimeNetwork!, session.airtimeRecipient!,
      session.airtimeAmount!, session.airtimeToDeliver!, session.dialingPhone!
    ))
  }

  const network = session.airtimeNetwork!
  const dialingPhone = session.dialingPhone!

  // Re-verify settings server-side
  if (!(await isAirtimeEnabled(network))) return end(`${network} airtime is no longer available.`)
  const { min, max } = await getAirtimeLimits()
  const amount = session.airtimeAmount!
  if (amount < min || amount > max) return end(`Amount must be GHS ${min}-${max}. Please restart.`)

  const provider = paystackProviderFromPhone(dialingPhone)
  if (!provider) return end("Payment not available for your number.")

  const { totalFeeRate, merchantCommissionRate } = await shopAirtimeFeeRate(session.shopId!, network)
  const { fee, toDeliver } = splitInclusive(amount, totalFeeRate)
  const commission = parseFloat((toDeliver * merchantCommissionRate / 100).toFixed(2))

  const referenceCode = secureReference("AT", 2, 3)
  const orderResult = await createShopAirtimeOrder({
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
        amount,
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
          reference: orderId, amount, email,
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
