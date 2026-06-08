import { createClient } from "@supabase/supabase-js"

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

// 'MTN' → 'mtn', 'Telecel' → 'telecel', 'AT' → 'at' (admin_settings key suffix)
export function airtimeNetworkKey(network: string): string {
  return network.toLowerCase()
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

/** Platform base fee rate (%) for a network, by buyer tier. */
export async function airtimeBaseFeeRate(network: string, isDealer: boolean): Promise<number> {
  const key = isDealer
    ? `airtime_fee_${airtimeNetworkKey(network)}_dealer`
    : `airtime_fee_${airtimeNetworkKey(network)}_customer`
  const s = await getAdminSetting(key)
  return s?.rate ?? 5
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
