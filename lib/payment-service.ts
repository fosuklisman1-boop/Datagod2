/**
 * Client-side payment service for Paystack integration
 */

interface InitializePaymentRequest {
  amount: number
  email: string
  userId: string
  shopId?: string
  type?: string
  planId?: string
}

interface InitializePaymentResponse {
  success: boolean
  authorizationUrl: string
  accessCode: string
  reference: string
  paymentId: string
}

interface VerifyPaymentRequest {
  reference: string
}

interface VerifyPaymentResponse {
  success: boolean
  status: "success" | "failed" | "pending"
  amount: number
  reference: string
  message: string
}

/**
 * Initialize a payment with Paystack
 */
export async function initializePayment(
  params: InitializePaymentRequest
): Promise<InitializePaymentResponse> {
  try {
    console.log("[PAYMENT-SERVICE] Initializing payment with params:", params)
    const response = await fetch("/api/payments/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    })

    console.log("[PAYMENT-SERVICE] Response status:", response.status)

    if (!response.ok) {
      const errorData = await response.json()
      console.error("[PAYMENT-SERVICE] Error response:", errorData)
      throw new Error(errorData.error || `Failed to initialize payment (${response.status})`)
    }

    const data = await response.json()
    console.log("[PAYMENT-SERVICE] Successfully initialized payment:", data)
    return data
  } catch (error) {
    console.error("[PAYMENT-SERVICE] Error initializing payment:", error)
    throw error
  }
}

/**
 * Verify a payment with Paystack
 */
export async function verifyPayment(
  params: VerifyPaymentRequest
): Promise<VerifyPaymentResponse> {
  try {
    const response = await fetch("/api/payments/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    })

    if (!response.ok) {
      const errorData = await response.json()
      throw new Error(errorData.error || "Failed to verify payment")
    }

    const data = await response.json()
    return data
  } catch (error) {
    console.error("Error verifying payment:", error)
    throw error
  }
}

export default {
  initializePayment,
  verifyPayment,
}
