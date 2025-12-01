/**
 * Paystack Inline Payment Handler
 * Displays payment form directly on the page without redirects
 */

interface PaystackInlineOptions {
  key: string
  email: string
  amount: number
  reference: string
  onSuccess: (response: PaystackPaymentResponse) => void
  onClose: () => void
}

interface PaystackPaymentResponse {
  reference: string
  status: string
  message?: string
}

/**
 * Initialize Paystack inline payment
 * Loads the Paystack script and sets up payment handler
 */
export async function initializePaystackInline(options: PaystackInlineOptions): Promise<void> {
  const { key, email, amount, reference, onSuccess, onClose } = options

  // Load Paystack script if not already loaded
  await loadPaystackScript()

  if (!window.PaystackPop) {
    throw new Error("Paystack script failed to load")
  }

  console.log("[PAYSTACK-INLINE] Initializing payment handler")
  console.log("  Reference:", reference)
  console.log("  Amount:", amount)
  console.log("  Email:", email)

  // Configure and open payment modal
  const handler = window.PaystackPop.setup({
    key,
    email,
    amount,
    ref: reference,
    onClose: () => {
      console.log("[PAYSTACK-INLINE] Payment modal closed by user")
      onClose()
    },
    onSuccess: (transaction: PaystackPaymentResponse) => {
      console.log("[PAYSTACK-INLINE] Payment successful:", transaction.reference)
      onSuccess(transaction)
    },
  })

  handler.openIframe()
  console.log("[PAYSTACK-INLINE] Payment modal opened")
}

/**
 * Load Paystack script from CDN
 */
function loadPaystackScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    // Check if already loaded
    if (window.PaystackPop) {
      resolve()
      return
    }

    const script = document.createElement("script")
    script.src = "https://js.paystack.co/v1/inline.js"
    script.async = true

    script.onload = () => {
      console.log("[PAYSTACK-INLINE] Script loaded successfully")
      resolve()
    }

    script.onerror = () => {
      console.error("[PAYSTACK-INLINE] Failed to load Paystack script")
      reject(new Error("Failed to load Paystack script"))
    }

    document.body.appendChild(script)
  })
}

/**
 * Verify payment after successful inline payment
 */
export async function verifyPaystackPayment(reference: string): Promise<PaystackPaymentResponse> {
  console.log("[PAYSTACK-INLINE] Verifying payment reference:", reference)

  const response = await fetch("/api/payments/verify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ reference }),
  })

  if (!response.ok) {
    throw new Error("Payment verification failed")
  }

  const data = await response.json()
  console.log("[PAYSTACK-INLINE] Verification result:", data)

  return data
}
