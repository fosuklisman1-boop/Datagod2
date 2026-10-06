// lib/ussd-hubtel/services.ts
// Business lookups the Hubtel flows need, behind interfaces so router/flow tests use fakes.
// Defaults delegate to the same modules the Uzo flows use.
import { resolveDialer, type DialerInfo } from "@/lib/ussd/resolve-dialer"
import { isAirtimeEnabled, getAirtimeLimits, airtimeBaseFeeRate } from "@/lib/airtime-pricing"

export { resolveDialer }
export type { DialerInfo }

export interface AirtimeServices {
  isEnabled(network: string): Promise<boolean>
  getLimits(): Promise<{ min: number; max: number }>
  /** Platform fee rate (%) for the network; dealers and sub-agents pay the dealer rate. */
  feeRate(network: string, isDealer: boolean): Promise<number>
}

export function defaultAirtimeServices(): AirtimeServices {
  return { isEnabled: isAirtimeEnabled, getLimits: getAirtimeLimits, feeRate: airtimeBaseFeeRate }
}
