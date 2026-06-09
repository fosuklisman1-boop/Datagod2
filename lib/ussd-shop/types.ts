// Re-export shared Uzo gateway types
export type { UzoRequest, UzoResponse } from "@/lib/ussd/types"

export type USSDShopStep =
  | 'ENTER_SHOP_CODE'
  | 'SELECT_PRODUCT'
  | 'SELECT_NETWORK'
  | 'SELECT_BUNDLE'
  | 'ENTER_RECIPIENT'
  | 'CONFIRM'
  | 'SUBMIT_OTP'
  // Airtime (MoMo only)
  | 'SHOP_AIRTIME_ENTER_RECIPIENT'
  | 'SHOP_AIRTIME_SELECT_NETWORK'
  | 'SHOP_AIRTIME_ENTER_AMOUNT'
  | 'SHOP_AIRTIME_CONFIRM'
  // Results Checker (MoMo only)
  | 'SHOP_RC_SELECT_BOARD'
  | 'SHOP_RC_ENTER_QTY'
  | 'SHOP_RC_CONFIRM'

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
  parentShopId?: string            // set when shop is a sub-agent; catalog lives under parent
  shopName?: string
  networks?: string[]              // available networks for this shop
  network?: string                 // selected network
  paystackProvider?: string        // 'mtn' | 'vod' | 'tgo'
  bundleId?: string
  bundleSize?: string
  bundlePrice?: number
  bundlePage?: number
  bundlePageShown?: number        // actual bundles shown on the last rendered menu page
  bundleCache?: ShopBundleOption[]
  bundleTotal?: number
  recipientPhone?: string
  pendingOrderId?: string          // ussd_shop_orders.id; used by SUBMIT_OTP
  pendingOrderTable?: 'airtime_orders' | 'results_checker_orders' // SUBMIT_OTP target for airtime/RC (data bundles use ussd_shop_orders)
  // Shop Airtime (MoMo only)
  airtimeRecipient?: string        // beneficiary (local 0XXXXXXXXX)
  airtimeNetwork?: string          // 'MTN' | 'Telecel' | 'AT'
  airtimeAmount?: number           // total the caller pays (fee inclusive)
  airtimeToDeliver?: number        // amount the recipient receives
  airtimeFee?: number
  airtimeMerchantCommission?: number
  // Shop Results Checker (MoMo only)
  rcBoard?: string                 // 'WASSCE' | 'BECE' | 'NOVDEC'
  rcQty?: number
  rcUnitPrice?: number
  rcTotal?: number
  rcMerchantCommission?: number
  rcBoardOptions?: string[]
}
