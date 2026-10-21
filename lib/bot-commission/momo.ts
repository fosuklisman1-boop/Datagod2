import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { chargeMobileMoney, submitOtp } from "@/lib/paystack"
import { recordPayerPhone } from "@/lib/refunds/payer-phone"
import { ghanaSignificant, normalizeGhanaPhone } from "@/lib/phone-format"
import { paystackProviderFromPhone } from "@/lib/ussd/paystack-provider"
import { safeDbError } from "@/lib/ussd-hubtel/log-safe"
import { isPhoneOtpVerified, readStorefrontOtpRequiredStrict } from "@/lib/storefront-otp"
import {
  checkCommissionPayable, isStorefrontOrderType, newPaystackReference, STOREFRONT_ORDER_TABLE,
  STOREFRONT_PAYMENT_CHANNEL, STOREFRONT_PAYMENT_PURPOSE, type CommissionPayableRow,
} from "@/lib/storefront-commission/payment"
import { failBotCharge } from "./momo-fail"
import { clearBotOtpPointer, setBotOtpPointer, type BotOtpChannel, type BotOtpPointer } from "./otp-pointer"
import { botCapDeps } from "./runtime"

/** Internal order types of the bot commission orders (wallet_payments.order_type). */
export type BotOrderType = "cs_bill" | "cs_bundle"

export type BotChargeSurface = "ussd" | "ussd_shop" | "whatsapp" | "whatsapp_shop"

/** Surfaces that run without a shop / with the session's resolved shop. */
const MAIN_SURFACES: readonly BotChargeSurface[] = ["ussd", "whatsapp"]
const SHOP_SURFACES: readonly BotChargeSurface[] = ["ussd_shop", "whatsapp_shop"]
/** The WhatsApp bots: the buyer types the MoMo number, so the storefront OTP switch applies to it. */
const WHATSAPP_SURFACES: readonly BotChargeSurface[] = ["whatsapp", "whatsapp_shop"]

export interface BotChargeInput {
  orderType: BotOrderType
  orderId: string
  botSurface: BotChargeSurface
  /** Shop bots (USSD / WhatsApp): the session's resolved active shop. Main bots: null. */
  shopId: string | null
  /**
   * The session's authenticated number: the USSD dialling MSISDN, or the WhatsApp sender. The order's buyer_phone must
   * be this number, and a `send_otp` pointer is stored under it.
   */
  dialingPhone: string
  /**
   * The number to charge (provider, per-number cap, payer record, the prompt). Defaults to `dialingPhone`. On the Uzo
   * USSD surfaces it may only be the dialling number itself (anything else is NOT_PAYABLE); on WhatsApp it is the
   * MoMo number the buyer typed, subject to the storefront OTP switch (NEEDS_VERIFY).
   */
  payPhone?: string
}

/**
 * - `ok: true`: a prompt is out for this order. `status` is Paystack's charge status (`send_otp` => OTP pointer
 *   stored), or `"pending"` for an idempotent replay: the order already had a pending / ongoing payment row from the last
 *   15 minutes, whose `reference` is returned; no new row and no new prompt.
 * - `NOT_PAYABLE`: not this bot's / this buyer's still-open order (or an unusable `payPhone`). Nothing was written;
 *   the order was not touched.
 * - `NEEDS_VERIFY` (WhatsApp surfaces only): the storefront OTP switch is on (or could not be read) and the paying
 *   number has no SMS OTP verification. Nothing was written, no cap slot used, the order left open: verify the number
 *   (payer-verify.ts) and call again with the same order.
 * - `NO_PROVIDER` / `RATE_LIMITED`: no prompt sent; the order WAS failed (guarded patch).
 * - `CHARGE_FAILED`: no prompt was sent by this call, but the ORDER MAY STILL BE OPEN (pending + unpaid):
 *   - the order could not be read, or the replay lookup failed: nothing written, the order left as is (ownership /
 *     a live earlier prompt could not be ruled out);
 *   - the payment row insert or the charge call failed / was refused: the order was failed (guarded patch).
 *   Callers show the generic error and must not assume the order is closed.
 */
export type BotChargeResult =
  | { ok: true; reference: string; status: string }
  | { ok: false; code: "NOT_PAYABLE" | "NEEDS_VERIFY" | "NO_PROVIDER" | "RATE_LIMITED" | "CHARGE_FAILED"; message: string }

/** A pending / ongoing payment row this recent for the same order is replayed instead of prompting again. */
export const BOT_MOMO_REPLAY_WINDOW_MS = 15 * 60 * 1000
/** Payment-row statuses that mean a prompt may still be live (never 'completed' / 'failed' / 'abandoned'). */
export const BOT_MOMO_REPLAY_STATUSES = ["pending", "ongoing"]

export interface BotMomoDeps {
  /** Service-role client. */
  db: SupabaseClient
  chargeMobileMoney: typeof chargeMobileMoney
  submitOtp: typeof submitOtp
  recordPayerPhone: typeof recordPayerPhone
  /** Atomic sliding-window limiter (applyRateLimit's store); true = allowed. Fails open like applyRateLimit. */
  rateLimit(name: string, max: number, windowMs: number, id: string): Promise<boolean>
  otpPointer: { set(phone: string, p: BotOtpPointer): Promise<void>; clear(phone: string, channel?: BotOtpChannel): Promise<void> }
  /**
   * The storefront OTP switch for the typed paying number (WhatsApp surfaces only). `required` THROWS when the switch
   * cannot be read (treated as on); `verified` = a real SMS OTP verification for the number (a throw = not verified).
   */
  payerOtp: { required(): Promise<boolean>; verified(phone: string): Promise<boolean> }
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
  NEEDS_VERIFY: "Please verify this MoMo number first.",
  NO_PROVIDER: "Payment not available for your number.",
  RATE_LIMITED: "Too many attempts. Please try later.",
  CHARGE_FAILED: "Service unavailable. Please try again later.",
} as const

const TAG = "BOT-MOMO"
const refuse = (code: keyof typeof BOT_MOMO_MESSAGES): BotChargeResult => ({ ok: false, code, message: BOT_MOMO_MESSAGES[code] })

interface BotPayableRow extends CommissionPayableRow { bot_surface: string | null }

/**
 * Charge a bot commission order (created by the engine) by a Paystack MoMo prompt to the paying number: the dialing
 * number on the Uzo USSD, the typed `payPhone` on WhatsApp (default: the session's number). The in-process twin of
 * /api/payments/initialize's momoDirect path for channel 'bots' rows (that route is IP-limited):
 *
 * 1. Re-read the order: only a channel 'bots' row of THIS surface (and, on a shop bot, this shop; on a main bot, no
 *    shop), still pending AND unpaid, bought by this session's number (`dialingPhone`; checkCommissionPayable +
 *    surface checks). Anything else is NOT_PAYABLE with no write at all. A pending / ongoing payment row for the order from the
 *    last 15 minutes is replayed (its reference returned, status "pending"): one order never gets two prompts from a
 *    resent confirm.
 * 2. Provider from the paying number; on WhatsApp, the storefront OTP switch for the paying number (NEEDS_VERIFY, no
 *    write); then the per-number cap on the paying number. A provider / cap refusal fails the order (guarded): a
 *    charge that never starts never leaves a chargeable order behind.
 * 3. One wallet_payments row (order_type cs_bill / cs_bundle, amount = paid_amount, fee 0, opaque reference), then the
 *    charge at paid_amount. Nothing sent to Paystack names the product. A charge that throws / is refused marks the
 *    payment row failed and fails the order with the guarded patch (a paid order is never touched).
 * 4. Payer phone (the paying number) recorded for refund payouts; `send_otp` stores the OTP pointer under the
 *    session's number (`dialingPhone`: the USSD dialler / the WhatsApp sender), never under the paying number.
 *
 * Confirmation is the existing charge.success webhook (reference -> wallet_payments -> settleStorefrontWebhook).
 */
export async function botChargeMomo(d: BotMomoDeps, i: BotChargeInput): Promise<BotChargeResult> {
  if (!isStorefrontOrderType(i.orderType)) return refuse("NOT_PAYABLE")
  if (MAIN_SURFACES.includes(i.botSurface) ? i.shopId !== null : SHOP_SURFACES.includes(i.botSurface) ? !i.shopId : true) {
    return refuse("NOT_PAYABLE")
  }
  const whatsapp = WHATSAPP_SURFACES.includes(i.botSurface)
  // The number to charge. A given payPhone must be a Ghana mobile number; on the Uzo USSD it may only be the dialler.
  const paySig = ghanaSignificant(i.payPhone ?? i.dialingPhone)
  if (i.payPhone !== undefined) {
    if (!paySig) return refuse("NOT_PAYABLE")
    if (!whatsapp && paySig !== ghanaSignificant(i.dialingPhone)) return refuse("NOT_PAYABLE")
  }
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

  // Idempotent replay: a resent confirm / second call must not prompt the same order twice.
  try {
    const { data, error } = await d.db
      .from("wallet_payments")
      .select("reference, created_at")
      .eq("order_id", i.orderId)
      .eq("order_type", i.orderType)
      // A live prompt: our 'pending' row, or one Paystack has since marked 'ongoing'.
      .in("status", BOT_MOMO_REPLAY_STATUSES)
      .gte("created_at", new Date(d.now() - BOT_MOMO_REPLAY_WINDOW_MS).toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
    if (error) throw error
    const prior = (data as { reference: string }[] | null)?.[0]
    if (prior?.reference) return { ok: true, reference: prior.reference, status: "pending" }
  } catch (e) {
    console.error(`[${TAG}] replay lookup failed for ${i.orderId}:`, safeDbError(e))
    return refuse("CHARGE_FAILED")
  }

  // `dialSig` passed above, so both are set (without payPhone, paySig === dialSig).
  const dialLocal = normalizeGhanaPhone(i.dialingPhone)!
  const local = "0" + paySig!
  const provider = paystackProviderFromPhone(local)
  if (!provider) {
    await failBotCharge(d.db, i.orderType, i.orderId, null, TAG)
    return refuse("NO_PROVIDER")
  }
  // WhatsApp: the typed paying number follows the storefront OTP switch. Fails closed: an unreadable switch counts as
  // on, an unreadable verification as unverified. Before the cap, so a refusal never spends a slot; no write at all.
  if (whatsapp && !(await payerVerifiedOrNotRequired(d, local))) return refuse("NEEDS_VERIFY")
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
      metadata: { source: whatsapp ? "whatsapp_bot" : "ussd_bot", bot_surface: i.botSurface, order_type: STOREFRONT_PAYMENT_CHANNEL },
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
      // Keyed by the session's authenticated number (dialler / WhatsApp sender), never the paying number: only this
      // session's owner can ever submit the code for this order.
      // Each channel has its own key space (Uzo: ussd-bot-otp, unchanged; WhatsApp: wa-bot-otp).
      const pointer: BotOtpPointer = { reference, orderType: i.orderType, orderId: i.orderId, createdAt }
      if (whatsapp) pointer.channel = "whatsapp"
      await d.otpPointer.set(dialLocal, pointer)
    } catch (e) {
      console.error(`[${TAG}] could not store the OTP pointer for ${i.orderId}:`, e instanceof Error ? e.message : String(e))
    }
  }
  return { ok: true, reference, status }
}

/** Storefront OTP switch off, or the paying number verified. Fails closed (switch unreadable => required). */
async function payerVerifiedOrNotRequired(d: BotMomoDeps, local: string): Promise<boolean> {
  let required = true
  try {
    required = await d.payerOtp.required()
  } catch (e) {
    console.error(`[${TAG}] storefront OTP switch unreadable; requiring verification:`, e instanceof Error ? e.message : "error")
  }
  if (!required) return true
  try {
    return (await d.payerOtp.verified(local)) === true
  } catch (e) {
    console.error(`[${TAG}] payer verification lookup failed:`, e instanceof Error ? e.message : "error")
    return false
  }
}

/**
 * Service-role wiring: Paystack charge / OTP, payer-phone record, applyRateLimit's store, the Upstash OTP pointer, the
 * storefront OTP switch (strict read) and the strict SMS OTP verification lookup.
 */
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
    payerOtp: { required: readStorefrontOtpRequiredStrict, verified: isPhoneOtpVerified },
    now: Date.now,
  }
}
