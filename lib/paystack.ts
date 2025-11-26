/**
 * Paystack Payment Service
 * Handles all Paystack payment operations
 */

const PAYSTACK_BASE_URL = "https://api.paystack.co"
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY
const PAYSTACK_CURRENCY = process.env.PAYSTACK_CURRENCY || "NGN" // Default to NGN, can be overridden

interface InitializePaymentParams {
  email: string
  amount: number // Amount in GHS (will be converted to kobo)
  reference: string
  metadata?: Record<string, any>
  channels?: string[] // Payment channels: card, mobile_money, bank_transfer (per merchant config)
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
    const amountInKobo = params.amount * 100
    
    console.log("=== PAYSTACK LIB: initializePayment ===")
    console.log("Currency being used:", PAYSTACK_CURRENCY)
    console.log("Input amount (GHS):", params.amount)
    console.log("Converted to kobo:", amountInKobo)

    const requestBody = {
      email: params.email,
      amount: amountInKobo,
      reference: params.reference,
      currency: PAYSTACK_CURRENCY,
      metadata: params.metadata || {},
      channels: params.channels || [
        "card",
        "mobile_money",
        "bank_transfer",
      ],
    }

    console.log("Sending to Paystack API:", JSON.stringify(requestBody, null, 2))

    const response = await fetch(`${PAYSTACK_BASE_URL}/transaction/initialize`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    })

    const data: PaymentResponse = await response.json()

    console.log("Paystack API Status:", response.status)
    console.log("Paystack API Response:", JSON.stringify(data, null, 2))

    if (!data.status) {
      console.error("❌ PAYSTACK ERROR:", data.message)
      throw new Error(data.message || "Failed to initialize payment")
    }

    console.log("✓ Payment initialized successfully")
    return {
      authorizationUrl: data.data.authorization_url,
      accessCode: data.data.access_code,
      reference: data.data.reference,
    }
  } catch (error) {
    console.error("❌ Error initializing Paystack payment:", error)
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
  amount: number // Amount in GHS
  customer_email: string
  reference: string
  authorization: any
}> {
  try {
    console.log("=== PAYSTACK LIB: verifyPayment ===")
    console.log("Reference:", reference)

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

    console.log("Paystack verification response status:", data.status)

    if (!data.status) {
      console.error("❌ Paystack verification failed:", data.message)
      throw new Error(data.message || "Failed to verify payment")
    }

    const transaction = data.data
    const amountInGHS = transaction.amount / 100 // Convert from kobo
    
    console.log("Received from Paystack:")
    console.log("  - Amount (kobo):", transaction.amount)
    console.log("  - Amount (GHS):", amountInGHS)
    console.log("  - Status:", transaction.status)
    console.log("  - Customer email:", transaction.customer.email)

    return {
      status: transaction.status,
      amount: amountInGHS,
      customer_email: transaction.customer.email,
      reference: transaction.reference,
      authorization: transaction.authorization,
    }
  } catch (error) {
    console.error("❌ Error verifying Paystack payment:", error)
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
        amount: amount * 100, // Convert to kobo
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
