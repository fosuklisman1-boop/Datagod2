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

/** Reads one admin_settings value (null when missing). Injected so the gates stay pure and testable. */
export type AirtimeSettingReader = (key: string) => Promise<any>

/** Why an airtime purchase is refused by the admin switches/limits. `status` is the HTTP status routes return. */
export interface AirtimeGateRefusal {
  code: "NETWORK_DISABLED" | "INVALID_AMOUNT"
  status: 400 | 403
  message: string
}

/**
 * Admin per-network switch (`airtime_enabled_<suffix>`). Only an explicit `enabled: false` blocks —
 * a missing row means enabled, as it always has. Shared by purchaseAirtime() and the storefront route.
 */
export async function airtimeNetworkGate(network: string, getSetting: AirtimeSettingReader): Promise<AirtimeGateRefusal | null> {
  const enableSetting = await getSetting(airtimeEnabledKey(network))
  if (enableSetting?.enabled === false) {
    return { code: "NETWORK_DISABLED", status: 403, message: `Airtime for ${network} is currently unavailable` }
  }
  return null
}

/**
 * Admin min/max (`airtime_min_amount` / `airtime_max_amount`, defaults 1 / 500), applied to the airtime
 * amount the buyer typed (the face value).
 */
export async function airtimeAmountGate(amount: number, getSetting: AirtimeSettingReader): Promise<AirtimeGateRefusal | null> {
  const minSetting = await getSetting("airtime_min_amount")
  const maxSetting = await getSetting("airtime_max_amount")
  const minAmount = minSetting?.amount ?? 1
  const maxAmount = maxSetting?.amount ?? 500
  if (amount < minAmount) {
    return { code: "INVALID_AMOUNT", status: 400, message: `Minimum airtime amount is GHS ${minAmount}` }
  }
  if (amount > maxAmount) {
    return { code: "INVALID_AMOUNT", status: 400, message: `Maximum airtime amount is GHS ${maxAmount}` }
  }
  return null
}

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
