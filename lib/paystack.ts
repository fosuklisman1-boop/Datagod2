/**
 * Paystack Payment Service
 * Handles all Paystack payment operations
 */

const PAYSTACK_BASE_URL = "https://api.paystack.co"
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY

if (!PAYSTACK_SECRET_KEY) {
  throw new Error("PAYSTACK_SECRET_KEY is not set in environment variables")
}

interface InitializePaymentParams {
  email: string
  amount: number
  reference: string
  redirectUrl?: string
  metadata?: Record<string, any>
  channels?: string[]
}

interface VerifyPaymentParams {
  reference: string
}

interface PaymentResponse {
  status: boolean
  message: string
  data?: any
  error?: string
}

/**
 * Initialize a payment with Paystack
 * Supports all payment methods: card, bank transfer, USSD, QR code, mobile money, EFT, Apple Pay, Google Pay
 * @param params - Payment initialization parameters
 * @returns Payment authorization URL
 */
export async function initializePayment(
  params: InitializePaymentParams
): Promise<{ authorizationUrl: string; accessCode: string; reference: string }> {
  try {
    if (!params.email || !params.amount || !params.reference) {
      throw new Error("Missing required fields: email, amount, reference")
    }

    if (params.amount <= 0) {
      throw new Error("Amount must be greater than 0")
    }

    console.log("[PAYSTACK] Initializing payment:")
    console.log("  Email:", params.email)
    console.log("  Amount:", params.amount)
    console.log("  Reference:", params.reference)

    const requestBody = {
      email: params.email,
      amount: Math.round(params.amount * 100), // Convert to smallest unit (kobo/pesewa)
      reference: params.reference,
      redirect_url: params.redirectUrl || undefined,
      metadata: params.metadata || {},
      channels: params.channels || [
        "card",
        "mobile_money",
        "bank_transfer",
      ],
    }

    const response = await fetch(`${PAYSTACK_BASE_URL}/transaction/initialize`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    })

    const data: PaymentResponse = await response.json()

    console.log("[PAYSTACK] Response Status:", response.status)
    console.log("[PAYSTACK] Response Body:", JSON.stringify(data, null, 2))

    if (!response.ok || !data.status) {
      console.error("[PAYSTACK] ✗ Error Response:", data)
      throw new Error(data.message || `HTTP ${response.status}`)
    }

    console.log("[PAYSTACK] ✓ Payment initialized")
    console.log("  Access Code:", data.data.access_code)

    return {
      authorizationUrl: data.data.authorization_url,
      accessCode: data.data.access_code,
      reference: data.data.reference,
    }
  } catch (error) {
    console.error("[PAYSTACK] ✗ Error initializing payment:", error)
    throw error
  }
}

/**
 * Verify a payment with Paystack
 * @param reference - Payment reference
 * @returns Verification result
 */
export async function verifyPayment(
  reference: string
): Promise<{
  status: "success" | "failed" | "pending"
  amount: number
  customer_email: string
  reference: string
  authorization: any
}> {
  try {
    if (!reference) {
      throw new Error("Payment reference is required")
    }

    console.log("[PAYSTACK] Verifying payment:", reference)

    const response = await fetch(
      `${PAYSTACK_BASE_URL}/transaction/verify/${reference}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        },
      }
    )

    const data: PaymentResponse = await response.json()

    if (!response.ok || !data.status) {
      console.error("[PAYSTACK] Verification failed:", data)
      throw new Error(data.message || "Payment verification failed")
    }

    const transaction = data.data

    console.log("[PAYSTACK] ✓ Verified")
    console.log("  Amount:", transaction.amount)
    console.log("  Status:", transaction.status)

    return {
      status: transaction.status,
      amount: transaction.amount / 100, // Convert from smallest unit back to GHS
      customer_email: transaction.customer.email,
      reference: transaction.reference,
      authorization: transaction.authorization,
    }
  } catch (error) {
    console.error("[PAYSTACK] ✗ Error verifying:", error)
    throw error
  }
}

/**
 * Get payment details from Paystack
 * @param transactionId - Transaction ID
 * @returns Transaction details
 */
export async function getTransactionDetails(transactionId: string) {
  try {
    const response = await fetch(
      `${PAYSTACK_BASE_URL}/transaction/${transactionId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        },
      }
    )

    const data: PaymentResponse = await response.json()

    if (!data.status) {
      throw new Error(data.message || "Failed to fetch transaction")
    }

    return data.data
  } catch (error) {
    console.error("Error fetching transaction details:", error)
    throw error
  }
}

/**
 * Get customer by email
 * @param email - Customer email
 * @returns Customer details
 */
export async function getCustomer(email: string) {
  try {
    const response = await fetch(
      `${PAYSTACK_BASE_URL}/customer?perPage=1&from=${encodeURIComponent(email)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        },
      }
    )

    const data: PaymentResponse = await response.json()

    if (!data.status) {
      return null
    }

    return data.data[0] || null
  } catch (error) {
    console.error("Error fetching customer:", error)
    return null
  }
}

/**
 * Create a transfer recipient (for payouts)
 * @param account_number - Bank account number
 * @param bank_code - Bank code
 * @param name - Recipient name
 * @returns Recipient code
 */
export async function createTransferRecipient(
  account_number: string,
  bank_code: string,
  name: string
) {
  try {
    const response = await fetch(`${PAYSTACK_BASE_URL}/transferrecipient`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "nuban",
        account_number,
        bank_code,
        name,
      }),
    })

    const data: PaymentResponse = await response.json()

    if (!data.status) {
      throw new Error(data.message || "Failed to create transfer recipient")
    }

    return data.data.recipient_code
  } catch (error) {
    console.error("Error creating transfer recipient:", error)
    throw error
  }
}

/**
 * Initiate a transfer (payout)
 * @param amount - Amount in GHS
 * @param recipient - Recipient code
 * @param reason - Transfer reason
 * @returns Transfer details
 */
export async function initiateTransfer(
  amount: number,
  recipient: string,
  reason: string = "Wallet payout"
) {
  try {
    const response = await fetch(`${PAYSTACK_BASE_URL}/transfer`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: "balance",
        amount: amount,
        recipient,
        reason,
      }),
    })

    const data: PaymentResponse = await response.json()

    if (!data.status) {
      throw new Error(data.message || "Failed to initiate transfer")
    }

    return data.data
  } catch (error) {
    console.error("Error initiating transfer:", error)
    throw error
  }
}

export default {
  initializePayment,
  verifyPayment,
  getTransactionDetails,
  getCustomer,
  createTransferRecipient,
  initiateTransfer,
}
