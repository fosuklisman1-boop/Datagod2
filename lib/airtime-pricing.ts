import { createClient } from "@supabase/supabase-js"
import { airtimeSettingsSuffix } from "./airtime-fee"
import { serviceRatesFor } from "./roles/service-rates"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export type AirtimeNetwork = "MTN" | "Telecel" | "AT"

// Ghana airtime networks by phone prefix. AT == AirtelTigo.
const AIRTIME_PREFIX: Record<string, AirtimeNetwork> = {
  "024": "MTN", "054": "MTN", "055": "MTN", "059": "MTN", "025": "MTN", "053": "MTN",
  "050": "Telecel", "020": "Telecel",
  "027": "AT", "057": "AT", "026": "AT", "028": "AT", "056": "AT",
}

export function detectAirtimeNetwork(localPhone: string): AirtimeNetwork | null {
  return AIRTIME_PREFIX[localPhone.slice(0, 3)] ?? null
}

// 'MTN' → 'mtn', 'Telecel' → 'telecel', 'AT' / 'AirtelTigo' → 'at' (admin_settings key suffix)
export function airtimeNetworkKey(network: string): string {
  return airtimeSettingsSuffix(network)
}

async function getAdminSetting(key: string): Promise<any> {
  const { data } = await supabase.from("admin_settings").select("value").eq("key", key).single()
  return data?.value ?? null
}

export async function isAirtimeEnabled(network: string): Promise<boolean> {
  const s = await getAdminSetting(`airtime_enabled_${airtimeNetworkKey(network)}`)
  return s?.enabled !== false
}

export async function getAirtimeLimits(): Promise<{ min: number; max: number }> {
  const [minS, maxS] = await Promise.all([
    getAdminSetting("airtime_min_amount"),
    getAdminSetting("airtime_max_amount"),
  ])
  return { min: minS?.amount ?? 1, max: maxS?.amount ?? 500 }
}

/**
 * Platform base fee rate (%) for a network, by role slug.
 *  - "dealer" / "user": today's `airtime_fee_<net>_dealer|_customer` admin setting (default 5), no roles read at all.
 *  - any other slug (a custom role): its role_service_rates row, else the next lower role, else those same two legacy
 *    values. Throws RoleReadError when roles / rates cannot be read: charge callers refuse before taking any money.
 */
export async function airtimeFeeRateFor(network: string, slug: string): Promise<number> {
  const net = airtimeNetworkKey(network)
  const dealerKey = `airtime_fee_${net}_dealer`
  const customerKey = `airtime_fee_${net}_customer`
  if (slug === "dealer") return (await getAdminSetting(dealerKey))?.rate ?? 5
  if (slug === "user") return (await getAdminSetting(customerKey))?.rate ?? 5

  const [dealerS, customerS] = await Promise.all([getAdminSetting(dealerKey), getAdminSetting(customerKey)])
  const legacy = { dealer: dealerS?.rate ?? 5, customer: customerS?.rate ?? 5 }
  const serviceKey = `airtime_fee:${net}`
  const rates = await serviceRatesFor(supabase, slug, [serviceKey], () => legacy)
  return rates.get(serviceKey) as number
}

/** Platform base fee rate (%) for a network, by buyer tier. */
export async function airtimeBaseFeeRate(network: string, isDealer: boolean): Promise<number> {
  return airtimeFeeRateFor(network, isDealer ? "dealer" : "user")
}

/**
 * Fee-inclusive split (pay_separately = false): the caller's `amount` is the
 * total they pay; the recipient receives `amount − fee`.
 */
export function splitInclusive(amount: number, rate: number): { fee: number; toDeliver: number } {
  const fee = parseFloat((amount * rate / (100 + rate)).toFixed(2))
  const toDeliver = parseFloat((amount - fee).toFixed(2))
  return { fee, toDeliver }
}
