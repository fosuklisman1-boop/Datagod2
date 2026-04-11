/**
 * Moolre Transfer API client.
 * Docs: https://docs.moolre.com
 *
 * Required env vars:
 *   MOOLRE_API_USER       — your Moolre username
 *   MOOLRE_API_KEY        — your Moolre API key
 *   MOOLRE_ACCOUNT_NUMBER — your Moolre source account number
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
  const apiUser = process.env.MOOLRE_API_USER
  const apiKey = process.env.MOOLRE_API_KEY
  if (!apiUser || !apiKey) {
    throw new Error("MOOLRE_API_USER and MOOLRE_API_KEY environment variables are required")
  }
  return {
    "X-API-USER": apiUser,
    "X-API-KEY": apiKey,
    "Content-Type": "application/json",
  }
}

function getMoolreAccountNumber(): string {
  const accountNumber = process.env.MOOLRE_ACCOUNT_NUMBER
  if (!accountNumber) {
    throw new Error("MOOLRE_ACCOUNT_NUMBER environment variable is required")
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
    console.log(`[MOOLRE-TRANSFER] ExternalRef: ${params.externalref}, Response:`, json)

    const data = json.data
    if (!data) {
      console.warn("[MOOLRE-TRANSFER] No data in response:", json)
      return null
    }

    return {
      txstatus: Number(data.txstatus),
      transactionId: String(data.transactionid || ""),
      externalref: String(data.externalref || params.externalref),
      fee: parseFloat(data.amountfee || "0"),
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
    if (!data) {
      console.warn("[MOOLRE-STATUS] No data in response:", json)
      return null
    }

    return {
      txstatus: Number(data.txstatus),
      transactionId: String(data.transactionid || ""),
      externalref: String(data.externalref || externalref),
    }
  } catch (error) {
    console.error("[MOOLRE-STATUS] Error:", error)
    return null
  }
}
