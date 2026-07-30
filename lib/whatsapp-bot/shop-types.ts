export type WaShopStep =
  | 'ENTER_CODE'
  | 'SELECT_PRODUCT'
  | 'SELECT_NETWORK'
  | 'SELECT_BUNDLE'
  | 'ENTER_RECIPIENT'
  | 'ENTER_PAYMENT_PHONE'
  | 'CONFIRM'
  | 'SUBMIT_OTP'
  // Airtime (mirrors lib/ussd-shop/types.ts's SHOP_AIRTIME_* steps)
  | 'AIRTIME_ENTER_RECIPIENT'
  | 'AIRTIME_SELECT_NETWORK'
  | 'AIRTIME_ENTER_AMOUNT'
  | 'AIRTIME_ENTER_PAYMENT_PHONE'
  | 'AIRTIME_CONFIRM'
  // Results Checker (mirrors lib/ussd-shop/types.ts's SHOP_RC_* steps)
  | 'RC_SELECT_BOARD'
  | 'RC_ENTER_QTY'
  | 'RC_ENTER_PAYMENT_PHONE'
  | 'RC_CONFIRM'
  // Sticky "handed off to AI" marker (lib/whatsapp-bot/shop-router.ts). Once the
  // router escapes to the AI conversation handler, the session is set to this
  // step instead of being deleted — every subsequent reply (including a direct
  // answer to something the AI just asked, e.g. a MoMo number) goes straight
  // back to AI instead of being re-evaluated as "is this a shop code?", since no
  // shape-based heuristic can reliably tell the two apart. place_shop_order
  // (lib/ai-tools.ts) overwrites this with a real CONFIRM/AIRTIME_CONFIRM/
  // RC_CONFIRM step once the AI is ready to charge, which exits this mode.
  | 'AI_CONVERSATION'

export interface WaShopBundleOption {
  id: string
  size: string
  price: number
}

export interface WaShopSession {
  step: WaShopStep
  // Set once the shop code resolves (mirrors USSDShopSession's dialingPhone/shopCodeId/etc,
  // but there's no "dialingPhone" here — the customer's WhatsApp number IS the session key,
  // stored separately by the caller, not inside the session value).
  shopCodeId?: string
  shopId?: string
  parentShopId?: string
  shopName?: string
  networks?: string[]
  network?: string
  paystackProvider?: string
  // Data bundle flow
  bundleId?: string
  bundleSize?: string
  bundlePrice?: number
  bundlePage?: number
  bundlePageShown?: number
  bundleCache?: WaShopBundleOption[]
  bundleTotal?: number
  recipientPhone?: string
  // WhatsApp-specific: the MoMo number to charge (WhatsApp always asks explicitly —
  // never assumes the chatting number, matching the main WA bot's money-safety rule).
  paymentPhone?: string
  pendingOrderId?: string
  // Which table SUBMIT_OTP's order-status writes target — set explicitly by every
  // product's CONFIRM step (mirrors lib/ussd-shop/types.ts's USSDShopSession, which
  // leaves this undefined only for data-bundle orders; here it's always set so
  // SUBMIT_OTP never has to guess/default).
  pendingOrderTable?: 'ussd_shop_orders' | 'airtime_orders' | 'results_checker_orders'
  // Airtime flow
  airtimeRecipient?: string
  airtimeNetwork?: string
  airtimeAmount?: number
  airtimeToDeliver?: number
  airtimeFee?: number
  airtimeMerchantCommission?: number
  // Results Checker flow
  rcBoard?: string
  rcQty?: number
  rcUnitPrice?: number
  rcTotal?: number
  rcMerchantCommission?: number
  rcBoardOptions?: string[]
  dataBlocked?: boolean
}
