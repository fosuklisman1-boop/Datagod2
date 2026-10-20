import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { chargeMobileMoney, submitOtp } from "@/lib/paystack"
import { recordPayerPhone } from "@/lib/refunds/payer-phone"
import { ghanaSignificant, normalizeGhanaPhone } from "@/lib/phone-format"
import { paystackProviderFromPhone } from "@/lib/ussd/paystack-provider"
import { safeDbError } from "@/lib/ussd-hubtel/log-safe"
import {
  checkCommissionPayable, isStorefrontOrderType, newPaystackReference, STOREFRONT_ORDER_TABLE,
  STOREFRONT_PAYMENT_CHANNEL, STOREFRONT_PAYMENT_PURPOSE, type CommissionPayableRow,
} from "@/lib/storefront-commission/payment"
import { failBotCharge } from "./momo-fail"
import { clearBotOtpPointer, setBotOtpPointer, type BotOtpPointer } from "./otp-pointer"
import { botCapDeps } from "./runtime"

/** Internal order types of the bot commission orders (wallet_payments.order_type). */
export type BotOrderType = "cs_bill" | "cs_bundle"

export interface BotChargeInput {
  orderType: BotOrderType
  orderId: string
  botSurface: "ussd" | "ussd_shop"
  /** Shop USSD: the session's resolved active shop. Main USSD: null. */
  shopId: string | null
  /** The number that dialled: the only number ever prompted. */
  dialingPhone: string
}

export type BotChargeResult =
  | { ok: true; reference: string; status: string }
  | { ok: false; code: "NOT_PAYABLE" | "NO_PROVIDER" | "RATE_LIMITED" | "CHARGE_FAILED"; message: string }

export interface BotMomoDeps {
  /** Service-role client. */
  db: SupabaseClient
  chargeMobileMoney: typeof chargeMobileMoney
  submitOtp: typeof submitOtp
  recordPayerPhone: typeof recordPayerPhone
  /** Atomic sliding-window limiter (applyRateLimit's store); true = allowed. Fails open like applyRateLimit. */
  rateLimit(name: string, max: number, windowMs: number, id: string): Promise<boolean>
  otpPointer: { set(phone: string, p: BotOtpPointer): Promise<void>; clear(phone: string): Promise<void> }
  now(): number
}

/**
 * Per-phone charge cap: the storefront direct-charge `momodirect_phone` budget (3 / h), keyed `mp:<0XXXXXXXXX>`.
 * On top of the engine's pending-order caps.
 */
export const BOT_MOMO_PHONE_CAP = { name: "momodirect_phone", max: 3, windowMs: 60 * 60 * 1000 } as const

/** Buyer-facing texts (never provider or DB text). */
export const BOT_MOMO_MESSAGES = {
  NOT_PAYABLE: "Not available right now.",
  NO_PROVIDER: "Payment not available for your number.",
  RATE_LIMITED: "Too many attempts. Please try later.",
  CHARGE_FAILED: "Service unavailable. Please try again later.",
} as const

const TAG = "BOT-MOMO"
const refuse = (code: keyof typeof BOT_MOMO_MESSAGES): BotChargeResult => ({ ok: false, code, message: BOT_MOMO_MESSAGES[code] })

interface BotPayableRow extends CommissionPayableRow { bot_surface: string | null }

/**
 * Charge a USSD bot commission order (created by the engine) by a Paystack MoMo prompt to the dialing number. The
 * in-process twin of /api/payments/initialize's momoDirect path for channel 'bots' rows (that route is IP-limited):
 *
 * 1. Re-read the order: only a channel 'bots' row of THIS surface (and, on shop USSD, this shop; on main USSD, no
 *    shop), still pending AND unpaid, bought by this dialing number (checkCommissionPayable + surface checks).
 *    Anything else is NOT_PAYABLE with no write at all.
 * 2. Provider from the dialing number; then the per-phone cap. Either refusal fails the order (guarded): a charge
 *    that never starts never leaves a chargeable order behind.
 * 3. One wallet_payments row (order_type cs_bill / cs_bundle, amount = paid_amount, fee 0, opaque reference), then the
 *    charge at paid_amount. Nothing sent to Paystack names the product. A charge that throws / is refused marks the
 *    payment row failed and fails the order with the guarded patch (a paid order is never touched).
 * 4. Payer phone recorded (refund payouts); `send_otp` stores the redial OTP pointer.
 *
 * Confirmation is the existing charge.success webhook (reference -> wallet_payments -> settleStorefrontWebhook).
 */
export async function botChargeMomo(d: BotMomoDeps, i: BotChargeInput): Promise<BotChargeResult> {
  if (!isStorefrontOrderType(i.orderType)) return refuse("NOT_PAYABLE")
  if (i.botSurface === "ussd" ? i.shopId !== null : i.botSurface === "ussd_shop" ? !i.shopId : true) return refuse("NOT_PAYABLE")
  const table = STOREFRONT_ORDER_TABLE[i.orderType]

  let row: BotPayableRow | null
  try {
    const { data, error } = await d.db
      .from(table)
      .select("channel, bot_surface, shop_id, status, payment_status, paid_amount, buyer_email, buyer_phone")
      .eq("id", i.orderId)
      .maybeSingle()
    if (error) throw error
    row = (data as BotPayableRow | null) ?? null
  } catch (e) {
    console.error(`[${TAG}] could not read order ${i.orderId}:`, safeDbError(e))
    return refuse("CHARGE_FAILED")
  }

  const payable = checkCommissionPayable(row, i.shopId)
  if (!row || !payable.ok || !payable.bot || row.channel !== "bots" || row.bot_surface !== i.botSurface) return refuse("NOT_PAYABLE")
  if ((row.shop_id ?? null) !== i.shopId) return refuse("NOT_PAYABLE")
  const dialSig = ghanaSignificant(i.dialingPhone)
  if (!dialSig || ghanaSignificant(String(row.buyer_phone ?? "")) !== dialSig) return refuse("NOT_PAYABLE")

  const local = normalizeGhanaPhone(i.dialingPhone)!
  const provider = paystackProviderFromPhone(local)
  if (!provider) {
    await failBotCharge(d.db, i.orderType, i.orderId, null, TAG)
    return refuse("NO_PROVIDER")
  }
  const cap = BOT_MOMO_PHONE_CAP
  if (!(await d.rateLimit(cap.name, cap.max, cap.windowMs, `mp:${local}`))) {
    await failBotCharge(d.db, i.orderType, i.orderId, null, TAG)
    return refuse("RATE_LIMITED")
  }

  const reference = newPaystackReference()
  const createdAt = new Date(d.now()).toISOString()
  const amount = payable.amount
  const shopId = payable.shopId

  try {
    const { error } = await d.db.from("wallet_payments").insert([{
      user_id: null, shop_id: shopId, order_id: i.orderId, order_type: i.orderType, amount, fee: 0, reference,
      status: "pending", payment_method: "paystack", created_at: createdAt,
    }])
    if (error) throw error
  } catch (e) {
    console.error(`[${TAG}] payment record insert failed for ${i.orderId}:`, safeDbError(e))
    await failBotCharge(d.db, i.orderType, i.orderId, null, TAG)
    return refuse("CHARGE_FAILED")
  }

  let status: string
  try {
    status = (await d.chargeMobileMoney({
      email: payable.email,
      amount,
      phone: local,
      provider,
      reference,
      // Neutral labels only: the internal cs_bill / cs_bundle code stays in wallet_payments.order_type.
      metadata: { source: "ussd_bot", bot_surface: i.botSurface, order_type: STOREFRONT_PAYMENT_CHANNEL },
      channel: STOREFRONT_PAYMENT_CHANNEL,
      purpose: STOREFRONT_PAYMENT_PURPOSE,
    })).status
  } catch (e) {
    console.error(`[${TAG}] charge failed for ${i.orderId}:`, e instanceof Error ? e.message : String(e))
    await failBotCharge(d.db, i.orderType, i.orderId, reference, TAG)
    return refuse("CHARGE_FAILED")
  }
  if (status === "failed") {
    console.error(`[${TAG}] charge refused for ${i.orderId}`)
    await failBotCharge(d.db, i.orderType, i.orderId, reference, TAG)
    return refuse("CHARGE_FAILED")
  }

  // [REFUND] payer MoMo number for refund payouts. Never throws.
  await d.recordPayerPhone(d.db, {
    reference,
    rawPhone: local,
    baseRow: {
      user_id: null, reference, amount, fee: 0, email: payable.email, status: "pending",
      payment_type: "shop_order", shop_id: shopId, order_id: i.orderId, created_at: createdAt,
    },
  })

  if (status === "send_otp") {
    try {
      await d.otpPointer.set(local, { reference, orderType: i.orderType, orderId: i.orderId, createdAt })
    } catch (e) {
      console.error(`[${TAG}] could not store the OTP pointer for ${i.orderId}:`, e instanceof Error ? e.message : String(e))
    }
  }
  return { ok: true, reference, status }
}

/** Service-role wiring: Paystack charge / OTP, payer-phone record, applyRateLimit's store, the Upstash OTP pointer. */
export function getBotMomoRuntime(): BotMomoDeps {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  return {
    db,
    chargeMobileMoney,
    submitOtp,
    recordPayerPhone,
    // applyRateLimit's Upstash store (same wiring as the engine's caps).
    rateLimit: botCapDeps(db).limit,
    otpPointer: { set: setBotOtpPointer, clear: clearBotOtpPointer },
    now: Date.now,
  }
}
