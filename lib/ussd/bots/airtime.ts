// Commission-cashback glue for Uzo USSD airtime (main menu + shop menu), rail "paystack".
// Mirrors Plan 2 (lib/ussd-hubtel/flows/airtime*.ts): the shared pieces are imported from
// lib/ussd-hubtel/flows/airtime-cashback.ts, never copied. When no usable quote exists, callers run
// today's fee pricing untouched. Applied: the typed amount is the airtime FACE delivered; the caller
// pays quote.payAmount (face - customer cashback + Paystack payment fee).
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { quoteBotAirtime, type BotAirtimeDeps } from "@/lib/cashback/storefront-airtime"
import { getCashbackConfig } from "@/lib/cashback/config"
import { getUssdServiceVisibility } from "@/lib/ussd-service-visibility"
import { getAirtimeProvider } from "@/lib/airtime-provider"
import { isDigiWapyConfigured, isDigiWapyEnabledForNetwork } from "@/lib/digiwapy-provider"
import { samePrice, type StorefrontQuote } from "@/lib/cashback/quote"
import {
  cashbackAirtimeColumns, cashbackPromptApplies, usableCashbackQuote,
} from "@/lib/ussd-hubtel/flows/airtime-cashback"
import { fitsUzo, uzoConfirmText } from "./screen"

/**
 * Cashback-branch amount rule: whole cedis with at most 2 decimals, digits only. Identical to Plan 2's
 * AMOUNT_RE (lib/ussd-hubtel/flows/airtime.ts, module-private there; Hubtel left untouched). The face is
 * delivered as typed, so a sub-pesewa face must never reach the row or the provider.
 */
export const UZO_AIRTIME_AMOUNT_RE = /^\d+(\.\d{1,2})?$/

let client: SupabaseClient | null = null
const db = (): SupabaseClient =>
  (client ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!))

const liveDeps = (): BotAirtimeDeps => ({
  getConfig: () => getCashbackConfig(db()),
  getProvider: (network) => getAirtimeProvider(db(), network, isDigiWapyEnabledForNetwork),
  digiwapyConfigured: () => isDigiWapyConfigured(),
})

/**
 * Uzo-only opt-in: `ussd_service_visibility.cashbackAirtime === true`. The shared bots airtime gate is also ON for
 * Hubtel USSD, so without this switch Uzo airtime would go cashback the moment it deploys. Missing key / read error
 * => off (today's pricing). Hubtel USSD never reads it.
 */
export async function uzoCashbackAirtimeOn(): Promise<boolean> {
  try {
    return (await getUssdServiceVisibility(db())).cashbackAirtime === true
  } catch (e) {
    console.error("[USSD-AIRTIME] cashbackAirtime switch unavailable; cashback off:", e instanceof Error ? e.message : "error")
    return false
  }
}

/**
 * Cashback quote for Uzo airtime on rail paystack, or null when cashback does not apply (Uzo opt-in off, bots
 * airtime gate off, provider earns nothing, above Hubtel's cap, any error). `shop` = shop USSD (storefront split).
 * Every cashback decision (prompt probe, amount, confirm re-quote) goes through here, so the opt-in covers them all.
 */
export async function uzoAirtimeQuote(network: string, face: number, shop: boolean): Promise<StorefrontQuote | null> {
  if (!(await uzoCashbackAirtimeOn())) return null
  return quoteBotAirtime(network, face, { rail: "paystack", shop }, liveDeps())
}

/** True when the amount prompt should ask for the airtime amount (probed at the minimum, as Plan 2). */
export function uzoAirtimePromptCashback(network: string, min: number, shop: boolean): Promise<boolean> {
  return cashbackPromptApplies(uzoAirtimeQuote, network, min, shop)
}

/** A quote the handlers may sell at for `face` (applied, finite, positive; fail closed otherwise). */
export async function uzoUsableAirtimeQuote(network: string, face: number, shop: boolean): Promise<StorefrontQuote | null> {
  const q = await uzoAirtimeQuote(network, face, shop)
  return usableCashbackQuote(q, face) && usableWalletBase(q) ? q : null
}

/** `base` (face - customer cashback) is the dealer-wallet price: finite, positive, never above payAmount. */
const usableWalletBase = (q: StorefrontQuote): boolean =>
  Number.isFinite(q.base) && q.base > 0 && q.base <= q.payAmount + 1e-9

/**
 * Confirm-time decision. The screen and the live quote must agree on BOTH the pricing mode and the
 * price: cashback switched on/off or re-rated since the screen => "changed" (no order, no charge).
 */
export type AirtimeRequote =
  | { kind: "legacy" }
  | { kind: "cashback"; quote: StorefrontQuote }
  | { kind: "changed" }

export function airtimeRequote(shownPay: number | undefined, live: StorefrontQuote | null, face: number): AirtimeRequote {
  const usable = usableCashbackQuote(live, face) && usableWalletBase(live)
  if (shownPay === undefined && !usable) return { kind: "legacy" }
  if (!usable || shownPay === undefined || !Number.isFinite(shownPay) || !samePrice(live.payAmount, shownPay)) {
    return { kind: "changed" }
  }
  return { kind: "cashback", quote: live }
}

/**
 * airtime_orders columns for an applied quote (MoMo pricing): face delivered, total_paid = payAmount,
 * the cashback snapshot via cashbackAirtimeColumns with fee_amount 0 (the Paystack fee lives only in
 * payment_fee_amount, so admin "profit" never counts it), and merchant_commission = the shop's cashback
 * share on shop USSD (0 on the main menu; no markup either way).
 */
export function uzoCashbackAirtimeColumns(q: StorefrontQuote, shop: boolean): Record<string, unknown> {
  const shopShare = shop ? q.shopShare : 0
  return {
    ...cashbackAirtimeColumns(q, shopShare),
    merchant_commission: shopShare,
  }
}

/**
 * Re-price patch for a cashback row paid from the dealer wallet: no Paystack payment, so no payment fee.
 * The wallet pays `base`; the cashback snapshot columns stay as inserted.
 */
export function uzoWalletRepriceColumns(base: number): Record<string, unknown> {
  return { total_paid: base, payment_fee_amount: 0, fee_amount: 0 }
}

/**
 * Cashback confirm screen: "Pay GHS x (was GHS y)", what the recipient gets, payer, 1. Confirm / 2. Cancel.
 * `header` (shop name) is prepended only when the whole screen still fits 160 chars.
 */
export function uzoAirtimeCashbackConfirm(o: {
  header?: string; label: string; recipient: string; pay: number; face: number; payer: string
}): string {
  const body = uzoConfirmText({
    pay: o.pay, face: o.face, receive: `GHS ${o.face.toFixed(2)} ${o.label} airtime`, recipient: o.recipient, payer: o.payer,
  })
  if (o.header) {
    const withHeader = `${o.header}\n${body}`
    if (fitsUzo(withHeader)) return withHeader
  }
  return body
}
