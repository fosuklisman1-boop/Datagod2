// Re-export shared Uzo gateway types
export type { UzoRequest, UzoResponse } from "@/lib/ussd/types"

export type USSDShopStep =
  | 'ENTER_SHOP_CODE'
  | 'SELECT_NETWORK'
  | 'SELECT_BUNDLE'
  | 'ENTER_RECIPIENT'
  | 'CONFIRM'
  | 'SUBMIT_OTP'

export interface ShopBundleOption {
  id: string
  size: string
  price: number  // packages.price + shop_packages.profit_margin
}

export interface USSDShopSession {
  step: USSDShopStep
  dialingPhone?: string
  shopCodeId?: string
  shopId?: string
  shopName?: string
  networks?: string[]              // available networks for this shop
  network?: string                 // selected network
  paystackProvider?: string        // 'mtn' | 'vod' | 'tgo'
  bundleId?: string
  bundleSize?: string
  bundlePrice?: number
  bundlePage?: number
  bundleCache?: ShopBundleOption[]
  bundleTotal?: number
  recipientPhone?: string
  pendingOrderId?: string          // ussd_shop_orders.id; used by SUBMIT_OTP
}
