/**
 * Moolre Transfer API client.
 * Docs: https://docs.moolre.com
 *
 * Required env vars:
 *   MOOLRE_TRANSFER_USER    — your Moolre username
 *   MOOLRE_TRANSFER_KEY     — your Moolre API key (X-API-KEY header)
 *   MOOLRE_TRANSFER_ACCOUNT — your Moolre source account number
 */

const MOOLRE_BASE = "https://api.moolre.com/open/transact"

const NETWORK_TO_CHANNEL: Record<string, number> = {
  MTN: 1,
  mtn: 1,
  Telecel: 6,
  telecel: 6,
  AT: 7,
  at: 7,
  AirtelTigo: 7,
  airteltigo: 7,
}

function getMoolreHeaders() {
  const apiUser = process.env.MOOLRE_TRANSFER_USER
  const apiKey = process.env.MOOLRE_TRANSFER_KEY
  if (!apiUser || !apiKey) {
    throw new Error("MOOLRE_TRANSFER_USER and MOOLRE_TRANSFER_KEY environment variables are required")
  }
  return {
    "X-API-USER": apiUser,
    "X-API-KEY": apiKey,
    "Content-Type": "application/json",
  }
}

function getMoolreAccountNumber(): string {
  const accountNumber = process.env.MOOLRE_TRANSFER_ACCOUNT
  if (!accountNumber) {
    throw new Error("MOOLRE_TRANSFER_ACCOUNT environment variable is required")
  }
  return accountNumber
}

/**
 * Validate a mobile money account name before initiating a transfer.
 * Returns the account holder name, or null if validation fails.
 */
export interface MoolreValidateResult {
  accountName: string | null
  error?: string
}

export async function validateAccountName(
  phone: string,
  network: string
): Promise<MoolreValidateResult> {
  const channel = NETWORK_TO_CHANNEL[network]
  if (!channel) {
    return { accountName: null, error: `Unsupported network: ${network}` }
  }

  try {
    const response = await fetch(`${MOOLRE_BASE}/validate`, {
      method: "POST",
      headers: getMoolreHeaders(),
      body: JSON.stringify({
        type: 1,
        receiver: phone,
        channel,
        currency: "GHS",
        accountnumber: getMoolreAccountNumber(),
      }),
    })

    const json = await response.json()
    console.log(`[MOOLRE-VALIDATE] Phone: ${phone}, Network: ${network}, Response:`, json)

    if (json.status === 1 && json.data) {
      return { accountName: json.data as string }
    }

    // Surface Moolre's actual error message
    const moolreMessage = json.message || json.data || "Account not found"
    console.warn(`[MOOLRE-VALIDATE] Validation failed:`, json)
    return { accountName: null, error: String(moolreMessage) }
  } catch (error) {
    console.error("[MOOLRE-VALIDATE] Error:", error)
    return { accountName: null, error: "Could not reach payment provider" }
  }
}

export interface MoolreTransferResult {
  txstatus: number       // 1=Success, 0=Pending, 2=Failed, 3=Unknown
  transactionId: string  // Moolre's internal ID
  externalref: string    // echoed back — matches what we sent
  fee: number            // amountfee charged
  insufficientBalance?: boolean  // true when Moolre wallet has no funds
  errorMessage?: string          // Moolre's raw error text
}

/**
 * Initiate a mobile money transfer.
 * Use the withdrawal request UUID as externalref to ensure idempotency.
 * Returns null if the API call itself fails (network error, auth error, etc.).
 */
export async function initiateTransfer(params: {
  phone: string
  network: string
  amount: number
  externalref: string  // withdrawal request UUID
  reference?: string   // human-readable memo shown to recipient
}): Promise<MoolreTransferResult | null> {
  const channel = NETWORK_TO_CHANNEL[params.network]
  if (!channel) {
    console.error(`[MOOLRE-TRANSFER] Unknown network: ${params.network}`)
    return null
  }

  try {
    const response = await fetch(`${MOOLRE_BASE}/transfer`, {
      method: "POST",
      headers: getMoolreHeaders(),
      body: JSON.stringify({
        type: 1,
        channel,
        currency: "GHS",
        amount: params.amount.toFixed(2),
        receiver: params.phone,
        externalref: params.externalref,
        reference: params.reference || `Withdrawal ${params.externalref}`,
        accountnumber: getMoolreAccountNumber(),
      }),
    })

    const json = await response.json()
    console.log(`[MOOLRE-TRANSFER] ExternalRef: ${params.externalref}, HTTP: ${response.status}, Response:`, json)

    // Handle HTTP 400 error responses from Moolre (insufficient balance, invalid account, etc.)
    if (!response.ok) {
      const code = json.code || ""
      const message = Array.isArray(json.message) ? json.message[0] : (json.message || "Transfer rejected")
      const isInsufficientBalance = code === "400_INSUFFICIENT_BALANCE" ||
        String(message).toLowerCase().includes("insufficient")

      console.error(`[MOOLRE-TRANSFER] HTTP ${response.status} error:`, json)
      return {
        txstatus: 2,
        transactionId: "",
        externalref: params.externalref,
        fee: 0,
        insufficientBalance: isInsufficientBalance,
        errorMessage: String(message),
      }
    }

    const data = json.data
    console.log("[MOOLRE-TRANSFER] Raw data field:", data)

    // txstatus may be on data or at the top level depending on Moolre response variant
    const rawTxstatus = data?.txstatus ?? json.txstatus
    const txstatus = rawTxstatus !== undefined && rawTxstatus !== null
      ? Number(rawTxstatus)
      : Number(json.status) === 1 ? 1 : 3  // fall back to top-level status, unknown=3

    if (isNaN(txstatus)) {
      console.warn("[MOOLRE-TRANSFER] Could not parse txstatus, treating as unknown:", json)
    }

    return {
      txstatus,
      transactionId: String(data?.transactionid ?? json.transactionid ?? ""),
      externalref: String(data?.externalref ?? json.externalref ?? params.externalref),
      fee: parseFloat(String(data?.amountfee ?? json.amountfee ?? "0")),
    }
  } catch (error) {
    console.error("[MOOLRE-TRANSFER] Error:", error)
    return null
  }
}

export interface MoolreStatusResult {
  txstatus: number      // 1=Success, 0=Pending, 2=Failed, 3=Unknown
  transactionId: string
  externalref: string
}

/**
 * Check the status of a previously initiated transfer using the externalref.
 * Returns null if the API call itself fails.
 */
export async function getTransferStatus(externalref: string): Promise<MoolreStatusResult | null> {
  try {
    const response = await fetch(`${MOOLRE_BASE}/status`, {
      method: "POST",
      headers: getMoolreHeaders(),
      body: JSON.stringify({
        type: 1,
        idtype: 1,  // 1 = lookup by externalref
        id: externalref,
        accountnumber: getMoolreAccountNumber(),
      }),
    })

    const json = await response.json()
    console.log(`[MOOLRE-STATUS] ExternalRef: ${externalref}, Response:`, json)

    const data = json.data
    console.log("[MOOLRE-STATUS] Raw data field:", data)

    const rawTxstatus = data?.txstatus ?? json.txstatus
    const txstatus = rawTxstatus !== undefined && rawTxstatus !== null
      ? Number(rawTxstatus)
      : Number(json.status) === 1 ? 1 : 3

    return {
      txstatus,
      transactionId: String(data?.transactionid ?? json.transactionid ?? ""),
      externalref: String(data?.externalref ?? json.externalref ?? externalref),
    }
  } catch (error) {
    console.error("[MOOLRE-STATUS] Error:", error)
    return null
  }
}
