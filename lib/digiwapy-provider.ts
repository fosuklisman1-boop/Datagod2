// lib/digiwapy-provider.ts
import crypto from "crypto"
import { createClient } from "@supabase/supabase-js"

const DEFAULT_BASE_URL = "https://api.digiwapy.com/v1"
// api.digiwapy.com has served a fatal TLS handshake alert since 2026-07-02
// (its custom-domain cert in front of Digiwapy's Supabase project is gone),
// which Node surfaces as "fetch failed". The same API stays reachable on the
// raw Supabase functions host, so network-level failures retry there once.
const FALLBACK_BASE_URL = "https://uzizihluxnhxnsluokki.supabase.co/functions/v1/api/v1"

function getBaseUrl(): string {
  return process.env.DIGIWAPY_BASE_URL || DEFAULT_BASE_URL
}

async function digiwapyFetch(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const base = getBaseUrl()
  try {
    return await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err: any) {
    if (base === FALLBACK_BASE_URL) throw err
    console.warn(`[DIGIWAPY] ${path} failed on ${base} (${err?.message ?? err}); retrying via fallback host`)
    return await fetch(`${FALLBACK_BASE_URL}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  }
}

// Module-level Supabase client (reused across calls)
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

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

function getRequestHeadersWithIdempotency(idempotencyKey: string): Record<string, string> {
  return {
    ...getRequestHeaders(),
    "X-Idempotency-Key": idempotencyKey,
  }
}

export interface DigiWapyAirtimeResult {
  success: boolean
  message: string
  /** Reference assigned by Digiwapy — use this for status polling */
  digiwapyRef?: string
}

export async function sendAirtimeViaDigiwapy(params: {
  network: string
  recipient: string
  amount: number
  reference: string
  /**
   * Deliberate re-attempt (admin retry): rotate the idempotency key so
   * Digiwapy runs a new transaction instead of replaying the cached response
   * of a previous (failed) one. The automatic payment-path send keeps the
   * stable key so duplicate webhooks can't double-send.
   */
  freshAttempt?: boolean
}): Promise<DigiWapyAirtimeResult> {
  const idempotencyKey = params.freshAttempt
    ? `AIRTIME-${params.reference}-R${Date.now()}`
    : `AIRTIME-${params.reference}`
  const headers = getRequestHeadersWithIdempotency(idempotencyKey) // throws if env vars missing — intentional
  try {
    const res = await digiwapyFetch("/airtime/send", {
      method: "POST",
      headers,
      body: JSON.stringify({
        network: NETWORK_MAP[params.network] ?? params.network,
        recipient: params.recipient,
        amount: params.amount,
        reference: params.reference,
      }),
    }, 30_000)
    const data = await res.json()
    console.log(`[DIGIWAPY] sendAirtime response (${res.status}):`, JSON.stringify(data))
    if (!res.ok) {
      return { success: false, message: data.message ?? data.error ?? `HTTP ${res.status}` }
    }
    // Capture the Digiwapy-assigned reference if present in the response
    const digiwapyRef: string | undefined =
      data?.data?.reference ?? data?.reference ?? undefined
    return { success: true, message: data.message ?? "Airtime sent", digiwapyRef }
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

export interface DigiWapyTransactionStatus {
  reference: string
  type: string
  amount: number
  status: "completed" | "failed" | "pending"
  recipient: string
  network: string
  description: string
  fee: number
  commission: number
  created_at: string
  updated_at: string
}

export async function fetchDigiWapyTransactionStatus(
  reference: string
): Promise<DigiWapyTransactionStatus | null> {
  try {
    const headers = getRequestHeaders() // inside try — returns null on any config error
    const res = await digiwapyFetch(
      `/transactions/status?reference=${encodeURIComponent(reference)}`,
      { headers },
      15_000
    )
    const data = await res.json()
    console.log(`[DIGIWAPY] txn status for ${reference} (${res.status}):`, JSON.stringify(data))
    if (!res.ok) return null
    return data.success ? (data.data as DigiWapyTransactionStatus) : null
  } catch (err: any) {
    console.error(`[DIGIWAPY] fetchTransactionStatus error for ${reference}:`, err?.message)
    return null
  }
}

export interface DigiWapyBalance {
  balance: number
  currency: string
  last_updated: string
}

export async function fetchDigiWapyBalance(): Promise<DigiWapyBalance | null> {
  try {
    const headers = getRequestHeaders() // inside try — returns null on any config error
    const res = await digiwapyFetch("/wallet/balance", { headers }, 10_000)
    if (!res.ok) return null
    const data = await res.json()
    return data.success ? (data.data as DigiWapyBalance) : null
  } catch (err: any) {
    console.error("[DIGIWAPY] fetchBalance error:", err?.message)
    return null
  }
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
  const networkId = network.toLowerCase() // MTN→mtn, Telecel→telecel, AT→at
  const key = `airtime_digiwapy_enabled_${networkId}`
  const { data, error } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle()
  console.log(`[DIGIWAPY] isEnabled check — key: ${key}, value: ${JSON.stringify(data?.value)}, error: ${error?.message ?? "none"}`)
  return data?.value?.enabled === true
}
