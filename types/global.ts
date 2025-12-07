/**
 * Global type definitions
 */

declare global {
  interface Window {
    PaystackPop: {
      setup: (config: PaystackConfig) => PaystackHandler
    }
  }
}

interface PaystackConfig {
  key: string
  email: string
  amount: number
  currency?: string
  ref: string
  onClose?: () => void
  onSuccess?: (response: PaystackSuccessResponse) => void
}

interface PaystackSuccessResponse {
  reference: string
  status: string
}

interface PaystackHandler {
  openIframe: () => void
}

export {}
