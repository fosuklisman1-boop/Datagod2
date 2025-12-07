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
  ref: string
  channels?: string[]
  metadata?: Record<string, any>
  onClose?: () => void
  callback?: (response: PaystackSuccessResponse) => void
  onSuccess?: (response: PaystackSuccessResponse) => void
}

interface PaystackSuccessResponse {
  reference: string
  status: string
  message?: string
  trans?: string
  transaction?: string
  trxref?: string
}

interface PaystackHandler {
  openIframe: () => void
}

export {}
