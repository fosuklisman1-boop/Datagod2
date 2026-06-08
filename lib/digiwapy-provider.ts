// lib/digiwapy-provider.ts
import crypto from "crypto"
import { createClient } from "@supabase/supabase-js"

const BASE_URL = "https://api.digiwapy.com/v1"

// Confirm Telecel/AT values with Digiwapy dashboard before going live
const NETWORK_MAP: Record<string, string> = {
  MTN: "MTN",
  Telecel: "Telecel",
  AT: "AirtelTigo",
}

function getRequestHeaders(): Record<string, string> {
  const apiKey = process.env.DIGIWAPY_API_KEY
  const partnerCode = process.env.DIGIWAPY_PARTNER_CODE
  if (!apiKey || !partnerCode) {
    throw new Error("DIGIWAPY_API_KEY or DIGIWAPY_PARTNER_CODE not set")
  }
  return {
    "Content-Type": "application/json",
    "X-API-Key": apiKey,
    "X-Partner-Code": partnerCode,
  }
}

export interface DigiWapyAirtimeResult {
  success: boolean
  message: string
}

export async function sendAirtimeViaDigiwapy(params: {
  network: string
  recipient: string
  amount: number
  reference: string
}): Promise<DigiWapyAirtimeResult> {
  try {
    const res = await fetch(`${BASE_URL}/airtime/send`, {
      method: "POST",
      headers: getRequestHeaders(),
      body: JSON.stringify({
        network: NETWORK_MAP[params.network] ?? params.network,
        recipient: params.recipient,
        amount: params.amount,
        reference: params.reference,
      }),
    })
    const data = await res.json()
    if (!res.ok) {
      return { success: false, message: data.message ?? data.error ?? `HTTP ${res.status}` }
    }
    return { success: true, message: data.message ?? "Airtime sent" }
  } catch (err: any) {
    return { success: false, message: err.message ?? "Request failed" }
  }
}

/**
 * Verify the X-Webhook-Signature header from a Digiwapy webhook.
 * Digiwapy signs JSON.stringify(parsedPayload), so pass the already-parsed
 * body object, not the raw text.
 */
export function verifyDigiWapyWebhookSignature(
  payload: unknown,
  signatureHeader: string
): boolean {
  const secret = process.env.DIGIWAPY_WEBHOOK_SECRET
  if (!secret) return false
  const expected = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(JSON.stringify(payload))
    .digest("hex")}`
  // Constant-time comparison to avoid timing attacks
  const aBuf = Buffer.from(expected)
  const bBuf = Buffer.from(signatureHeader)
  if (aBuf.length !== bBuf.length) return false
  return crypto.timingSafeEqual(aBuf, bBuf)
}

/** True when both required env vars are present. */
export function isDigiWapyConfigured(): boolean {
  return !!(process.env.DIGIWAPY_API_KEY && process.env.DIGIWAPY_PARTNER_CODE)
}

/**
 * Check admin_settings to see if Digiwapy auto-fulfillment is enabled for a
 * given network. Returns false immediately when env vars are not set.
 */
export async function isDigiWapyEnabledForNetwork(network: string): Promise<boolean> {
  if (!isDigiWapyConfigured()) return false
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  const networkId = network.toLowerCase() // MTN→mtn, Telecel→telecel, AT→at
  const key = `airtime_digiwapy_enabled_${networkId}`
  const { data } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle()
  return data?.value?.enabled === true
}
