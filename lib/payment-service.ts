/**
 * Client-side payment service for Paystack integration
 */

interface InitializePaymentRequest {
  amount: number
  email: string
  userId: string
  shopId?: string
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

/**
 * Open Paystack payment modal (inline)
 */
export function openPaystackModal(config: {
  key: string
  email: string
  amount: number
  reference: string
  onClose?: () => void
  onSuccess?: (reference: string) => void
  channels?: string[]
  metadata?: Record<string, any>
}) {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(new Error("Window not available"))
      return
    }

    if (!window.PaystackPop) {
      reject(new Error("Paystack script not loaded"))
      return
    }

    const handler = window.PaystackPop.setup({
      key: config.key,
      email: config.email,
      amount: Math.round(config.amount * 100), // Convert to kobo/pesewa
      ref: config.reference,
      channels: config.channels || ["card", "mobile_money", "bank_transfer"],
      metadata: config.metadata || {},
      onClose: () => {
        console.log("[PAYSTACK-INLINE] Payment modal closed")
        if (config.onClose) config.onClose()
        resolve(false)
      },
      callback: (response: any) => {
        console.log("[PAYSTACK-INLINE] Payment successful:", response.reference)
        if (config.onSuccess) config.onSuccess(response.reference)
        resolve(true)
      },
    })

    handler.openIframe()
  })
}

/**
 * Initialize payment for shop order and return payment config for inline
 */
export async function initializeShopPayment(params: {
  orderId: string
  shopId: string
  shopSlug: string
  amount: number
  email: string
  customerName: string
  customerPhone: string
}): Promise<{
  success: boolean
  reference: string
  accessCode: string
  paymentId: string
}> {
  try {
    console.log("[PAYMENT-SERVICE] Initializing shop payment:", params)
    
    const response = await fetch("/api/payments/shop/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    })

    if (!response.ok) {
      const errorData = await response.json()
      throw new Error(errorData.error || "Failed to initialize payment")
    }

    const data = await response.json()
    console.log("[PAYMENT-SERVICE] Shop payment initialized:", data)
    return data
  } catch (error) {
    console.error("[PAYMENT-SERVICE] Error initializing shop payment:", error)
    throw error
  }
}

export default {
  initializePayment,
  verifyPayment,
  openPaystackModal,
  initializeShopPayment,
}
