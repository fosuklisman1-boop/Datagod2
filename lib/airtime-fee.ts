// Pure, client-safe airtime fee helpers shared by the dashboard page and purchaseAirtime().
import { airtimeNetId } from "./airtime-provider"

export type AirtimeFeeTier = "customer" | "dealer"

/**
 * admin_settings key suffix for a network: "MTN" -> "mtn", "Telecel" -> "telecel",
 * "AT" / "AirtelTigo" -> "at" (production has no "airteltigo" keys). Unknown names keep the
 * historical lowercase form.
 */
export function airtimeSettingsSuffix(network: string): string {
  return airtimeNetId(network) ?? network.toLowerCase().replace(/\s/g, "_")
}

export const airtimeEnabledKey = (network: string): string => `airtime_enabled_${airtimeSettingsSuffix(network)}`

export const airtimeFeeKey = (network: string, tier: AirtimeFeeTier): string =>
  `airtime_fee_${airtimeSettingsSuffix(network)}_${tier}`

export interface LegacyAirtimePrice {
  /** Airtime delivered to the beneficiary. */
  toRecipient: number
  /** Service fee (total - toRecipient). */
  fee: number
  /** Wallet debit. */
  total: number
}

/**
 * Legacy (no cashback) fee maths. Pay separately: fee added on top. Otherwise the fee is deducted
 * from the typed amount. Exactly the rounding purchaseAirtime has always used.
 */
export function legacyAirtimePrice(amount: number, rate: number, paySeparately: boolean): LegacyAirtimePrice {
  let toRecipient: number
  let total: number
  if (paySeparately) {
    toRecipient = amount
    const fee = parseFloat((amount * rate / 100).toFixed(2))
    total = parseFloat((amount + fee).toFixed(2))
  } else {
    total = amount
    const fee = parseFloat((amount * rate / (100 + rate)).toFixed(2))
    toRecipient = parseFloat((total - fee).toFixed(2))
  }
  return { toRecipient, fee: parseFloat((total - toRecipient).toFixed(2)), total }
}
