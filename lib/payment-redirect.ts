/**
 * Payment redirect utility with Safari compatibility
 * Handles cross-browser payment redirects with proper timing and error handling
 */

interface PaymentRedirectOptions {
  url: string
  delayMs?: number
  onError?: (error: Error) => void
}

/**
 * Safely redirect to payment URL with Safari compatibility
 * Safari requires proper timing and event handling for redirects
 */
export async function redirectToPayment(options: PaymentRedirectOptions): Promise<void> {
  const { url, delayMs = 100, onError } = options

  try {
    new URL(url)
  } catch (error) {
    const err = new Error("Invalid payment URL")
    if (onError) onError(err)
    throw err
  }

  console.log("[PAYMENT-REDIRECT] Initiating redirect to:", url.substring(0, 100) + "...")
  console.log("[PAYMENT-REDIRECT] Browser:", getBrowserInfo())
  console.log("[PAYMENT-REDIRECT] Delay:", delayMs + "ms")

  return new Promise((resolve) => {
    setTimeout(() => {
      try {
        if (typeof window !== "undefined" && window.sessionStorage) {
          const existingRef = sessionStorage.getItem("lastPaymentReference")
          if (existingRef) {
            console.log("[PAYMENT-REDIRECT] Previous reference found:", existingRef)
          }
        }

        if (typeof window !== "undefined") {
          // Safari-specific handling: use _self target which works better on iOS Safari
          const isSafariBrowser = isSafari()
          
          if (isSafariBrowser) {
            console.log("[PAYMENT-REDIRECT] Using Safari-compatible redirect method")
            // For Safari, directly set location to avoid popup blockers
            window.location.href = url
          } else {
            // Standard redirect for other browsers
            window.location.href = url
          }
          
          console.log("[PAYMENT-REDIRECT] Redirect initiated successfully")
        }
        resolve()
      } catch (error) {
        const err = error instanceof Error ? error : new Error("Failed to redirect")
        console.error("[PAYMENT-REDIRECT] Error:", err)
        if (onError) onError(err)
        throw err
      }
    }, delayMs)
  })
}

/**
 * Check if user is on Safari browser
 */
export function isSafari(): boolean {
  if (typeof window === "undefined") return false

  const ua = navigator.userAgent.toLowerCase()
  const isChrome = /chrome|chromium/.test(ua)
  const isFirefox = /firefox/.test(ua)
  const isSafari = /safari/.test(ua) && !isChrome && !isFirefox

  return isSafari
}

/**
 * Get browser info for logging
 */
export function getBrowserInfo(): string {
  if (typeof window === "undefined") return "unknown"

  const ua = navigator.userAgent
  if (/Chrome/.test(ua)) return "Chrome"
  if (/Firefox/.test(ua)) return "Firefox"
  if (/Safari/.test(ua)) return "Safari"
  if (/Edge/.test(ua)) return "Edge"
  return "unknown"
}
