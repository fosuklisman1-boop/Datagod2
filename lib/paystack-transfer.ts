/**
 * Paystack Transfer API client for Ghana payouts — an admin-selectable
 * alternative to Moolre (lib/moolre-transfer.ts), chosen per withdrawal.
 * Ghana-specific recipient types, amount units, and the OTP/finalize flow
 * were verified against Paystack's public docs (2026-09-10) rather than
 * assumed — a wrong assumption about a third-party API has broken things
 * silently before in this project (AgentPortalGH, CodeCraft).
 *
 * Deliberately does NOT reuse the existing createTransferRecipient/
 * initiateTransfer in lib/paystack.ts: those only support Nigeria's `nuban`
 * recipient type and don't convert amounts to pesewas.
 *
 * Transfer OTP is left ENABLED (a deliberate choice, not a bug) — every
 * transfer needs a finalizeTransfer() call with an admin-entered code.
 */

const PAYSTACK_BASE_URL = "https://api.paystack.co"

function getPaystackHeaders() {
  const key = process.env.PAYSTACK_SECRET_KEY
  if (!key) throw new Error("PAYSTACK_SECRET_KEY environment variable is required")
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  }
}

const NETWORK_TO_BANK_CODE: Record<string, string> = {
  MTN: "MTN",
  TELECEL: "VOD",
  VODAFONE: "VOD",
  AT: "ATL",
  AIRTELTIGO: "ATL",
}

export function mapNetworkToPaystackBankCode(network: string): string | undefined {
  return NETWORK_TO_BANK_CODE[network.toUpperCase()]
}

/** Paystack expects GHS amounts in pesewas (× 100), same convention as its charge API. */
export function toPesewas(amountGHS: number): number {
  return Math.round(amountGHS * 100)
}

export interface PaystackBank {
  name: string
  code: string
}

/**
 * Case-insensitive EXACT match only — a wrong bank match on a money transfer
 * is unacceptable, so this never fuzzy-matches. Returns undefined on no match.
 */
export function matchBankByName(bankName: string, banks: PaystackBank[]): PaystackBank | undefined {
  const normalized = bankName.trim().toLowerCase()
  return banks.find(b => b.name.trim().toLowerCase() === normalized)
}

/**
 * Fetch Ghana's bank list (used to resolve `ghipss` bank-transfer recipients).
 * Returns [] on error — callers treat that the same as "no match found".
 */
export async function fetchGhanaBankList(): Promise<PaystackBank[]> {
  try {
    const response = await fetch(`${PAYSTACK_BASE_URL}/bank?currency=GHS`, {
      headers: getPaystackHeaders(),
    })
    const json = await response.json()
    if (!response.ok || !json.status || !Array.isArray(json.data)) {
      console.error("[PAYSTACK-TRANSFER] Bank list error:", json)
      return []
    }
    return json.data.map((b: any) => ({ name: String(b.name), code: String(b.code) }))
  } catch (error) {
    console.error("[PAYSTACK-TRANSFER] Bank list fetch error:", error)
    return []
  }
}

export interface CreateRecipientParams {
  name: string
  accountNumber: string   // phone (mobile money) or bank account number
  bankCode: string        // MTN/VOD/ATL, or a Paystack bank `code`
  type: "mobile_money" | "ghipss"
}

/**
 * Creates a fresh recipient every call — no caching/reuse (see plan's Global
 * Constraints). Returns Paystack's own rejection message on failure (e.g. an
 * invalid/unsupported bank_code) rather than a bare null, so callers can show
 * the admin the actual reason instead of a generic "could not create" error —
 * this is a real API integration point where the exact accepted values are
 * worth confirming against Paystack's own error text, not just assumed.
 */
export async function createRecipient(params: CreateRecipientParams): Promise<{ recipientCode: string; error?: undefined } | { recipientCode?: undefined; error: string }> {
  try {
    const response = await fetch(`${PAYSTACK_BASE_URL}/transferrecipient`, {
      method: "POST",
      headers: getPaystackHeaders(),
      body: JSON.stringify({
        type: params.type,
        name: params.name,
        account_number: params.accountNumber,
        bank_code: params.bankCode,
        currency: "GHS",
      }),
    })
    const json = await response.json()
    if (!response.ok || !json.status || !json.data?.recipient_code) {
      console.error("[PAYSTACK-TRANSFER] Recipient creation error:", json)
      return { error: String(json?.message ?? `HTTP ${response.status}`) }
    }
    return { recipientCode: String(json.data.recipient_code) }
  } catch (error) {
    console.error("[PAYSTACK-TRANSFER] Recipient creation fetch error:", error)
    return { error: error instanceof Error ? error.message : "Network error reaching Paystack" }
  }
}

export interface PaystackTransferResult {
  status: "success" | "otp" | "pending" | "failed"
  transferCode: string
  transactionReference: string
  fee: number             // GHS
  errorMessage?: string
}

function parseTransferResponse(json: any, fallbackReference: string): PaystackTransferResult {
  const data = json?.data
  const rawStatus = String(data?.status ?? "")
  const status: PaystackTransferResult["status"] =
    rawStatus === "success" || rawStatus === "otp" || rawStatus === "pending" ? rawStatus : "failed"
  return {
    status,
    transferCode: String(data?.transfer_code ?? ""),
    transactionReference: String(data?.reference ?? fallbackReference),
    fee: Number(data?.fee ?? 0) / 100,
    errorMessage: status === "failed" ? String(json?.message ?? "Transfer rejected by provider") : undefined,
  }
}

export interface InitiateTransferParams {
  recipientCode: string
  amount: number           // GHS — converted to pesewas internally
  reference: string        // withdrawal UUID — our idempotency key
  reason?: string
}

/**
 * Initiate a transfer. With OTP enabled (see module doc), this comes back
 * status:"otp" — call finalizeTransfer() with the admin-entered code next.
 */
export async function initiateTransfer(params: InitiateTransferParams): Promise<PaystackTransferResult | null> {
  try {
    const response = await fetch(`${PAYSTACK_BASE_URL}/transfer`, {
      method: "POST",
      headers: getPaystackHeaders(),
      body: JSON.stringify({
        source: "balance",
        amount: toPesewas(params.amount),
        recipient: params.recipientCode,
        reference: params.reference,
        reason: params.reason || `Datagod withdrawal ${params.reference.slice(0, 8)}`,
      }),
    })
    const json = await response.json()
    if (!response.ok && !json?.data) {
      console.error("[PAYSTACK-TRANSFER] Transfer error:", json)
      return { status: "failed", transferCode: "", transactionReference: params.reference, fee: 0, errorMessage: String(json?.message ?? `HTTP ${response.status}`) }
    }
    return parseTransferResponse(json, params.reference)
  } catch (error) {
    console.error("[PAYSTACK-TRANSFER] Transfer fetch error:", error)
    return null
  }
}

/** Completes a transfer that came back status:"otp", using the admin-entered code. */
export async function finalizeTransfer(transferCode: string, otp: string): Promise<PaystackTransferResult | null> {
  try {
    const response = await fetch(`${PAYSTACK_BASE_URL}/transfer/finalize_transfer`, {
      method: "POST",
      headers: getPaystackHeaders(),
      body: JSON.stringify({ transfer_code: transferCode, otp }),
    })
    const json = await response.json()
    if (!response.ok && !json?.data) {
      console.error("[PAYSTACK-TRANSFER] Finalize error:", json)
      return { status: "failed", transferCode, transactionReference: "", fee: 0, errorMessage: String(json?.message ?? `HTTP ${response.status}`) }
    }
    return parseTransferResponse(json, "")
  } catch (error) {
    console.error("[PAYSTACK-TRANSFER] Finalize fetch error:", error)
    return null
  }
}

/** Checks a previously-initiated transfer's current status by its reference. */
export async function getTransferStatus(reference: string): Promise<PaystackTransferResult | null> {
  try {
    const response = await fetch(`${PAYSTACK_BASE_URL}/transfer/verify/${encodeURIComponent(reference)}`, {
      headers: getPaystackHeaders(),
    })
    const json = await response.json()
    if (!response.ok || !json?.data) {
      console.error("[PAYSTACK-TRANSFER] Status check error:", json)
      return null
    }
    return parseTransferResponse(json, reference)
  } catch (error) {
    console.error("[PAYSTACK-TRANSFER] Status check fetch error:", error)
    return null
  }
}

export interface PaystackBalance {
  balance: number   // GHS
  currency: string
}

/** Fetches the GHS balance of the Paystack account (multiple currencies possible). */
export async function getPaystackTransferBalance(): Promise<PaystackBalance | null> {
  try {
    const response = await fetch(`${PAYSTACK_BASE_URL}/balance`, {
      headers: getPaystackHeaders(),
    })
    const json = await response.json()
    if (!response.ok || !json?.status || !Array.isArray(json.data)) {
      console.error("[PAYSTACK-TRANSFER] Balance error:", json)
      return null
    }
    const ghs = json.data.find((b: any) => b.currency === "GHS")
    if (!ghs) return null
    return { balance: Number(ghs.balance) / 100, currency: "GHS" }
  } catch (error) {
    console.error("[PAYSTACK-TRANSFER] Balance fetch error:", error)
    return null
  }
}
