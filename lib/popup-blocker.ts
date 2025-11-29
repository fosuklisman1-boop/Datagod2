/**
 * Utility functions to handle popup blocker scenarios
 */

export interface PopupBlockerCheckResult {
  isBlocked: boolean
  userAgent: string
}

/**
 * Detects if browser popup blocker is active
 * Works by attempting to open a small popup
 */
export function checkPopupBlocker(): PopupBlockerCheckResult {
  let isBlocked = false
  
  try {
    const testWindow = window.open("", "", "width=1,height=1")
    
    if (!testWindow || testWindow.closed) {
      isBlocked = true
    } else {
      testWindow.close()
    }
  } catch (e) {
    isBlocked = true
  }

  return {
    isBlocked,
    userAgent: navigator.userAgent,
  }
}

/**
 * Handles payment initialization with popup blocker fallback
 * Returns object with redirect URL and whether popup blocker was detected
 */
export function handlePaymentWithFallback(authorizationUrl: string, windowName: string = "payment") {
  const popupBlockerStatus = checkPopupBlocker()
  
  if (popupBlockerStatus.isBlocked) {
    // Popup is blocked, use full-page redirect instead
    console.warn("[PAYMENT] Popup blocker detected, using full-page redirect")
    return {
      method: "redirect" as const,
      url: authorizationUrl,
      message: "Redirecting to payment gateway...",
    }
  }

  // Try to open popup
  const popupWindow = window.open(
    authorizationUrl,
    windowName,
    "height=600,width=600,left=" + (screen.width / 2 - 300) + ",top=" + (screen.height / 2 - 300)
  )

  if (!popupWindow || popupWindow.closed) {
    // Popup was blocked after initial check
    console.warn("[PAYMENT] Popup window failed to open despite initial check, using redirect")
    return {
      method: "redirect" as const,
      url: authorizationUrl,
      message: "Redirecting to payment gateway...",
    }
  }

  // Successfully opened popup
  return {
    method: "popup" as const,
    window: popupWindow,
    message: "Payment window opened",
  }
}

/**
 * Stores payment reference for post-payment verification
 */
export function storePaymentReference(reference: string): void {
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.setItem("lastPaymentReference", reference)
  }
}

/**
 * Retrieves stored payment reference
 */
export function getPaymentReference(): string | null {
  if (typeof sessionStorage !== "undefined") {
    return sessionStorage.getItem("lastPaymentReference")
  }
  return null
}

/**
 * Clears stored payment reference
 */
export function clearPaymentReference(): void {
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.removeItem("lastPaymentReference")
  }
}
