export interface UzoRequest {
  ussdString: string     // dial code on init; user's input on continue
  msisdn: string         // dialing phone number e.g. "+233244123456"
  ussdServiceOp: string  // "1"=init, "18"=continue, "29+"=terminate
  sessionID: string
  network: string        // MNC code e.g. "06"
  code: string           // USSD code dialed e.g. "*1234#"
  country: string        // "GH"
}

export interface UzoResponse {
  message: string
  ussdServiceOp: 2 | 17  // 2=continue, 17=final
}

export type USSDStep =
  | 'MAIN'
  | 'SELECT_NETWORK'
  | 'SELECT_BUNDLE'
  | 'ENTER_RECIPIENT'
  | 'CONFIRM'
  | 'PAYMENT_METHOD'
  | 'SUBMIT_OTP'
  | 'CHECK_STATUS'
  | 'AFA_ENTER_NAME'
  | 'AFA_ENTER_CARD'
  | 'AFA_ENTER_LOCATION'
  | 'AFA_ENTER_REGION'
  | 'AFA_CONFIRM_AFA'
  // Airtime
  | 'AIRTIME_ENTER_RECIPIENT'
  | 'AIRTIME_SELECT_NETWORK'
  | 'AIRTIME_ENTER_AMOUNT'
  | 'AIRTIME_CONFIRM'
  | 'AIRTIME_PAYMENT_METHOD'
  // Results Checker
  | 'RC_MENU'
  | 'RC_SELECT_BOARD'
  | 'RC_ENTER_QTY'
  | 'RC_CONFIRM'
  | 'RC_PAYMENT_METHOD'
  | 'RC_MY_VOUCHERS'
  | 'RC_VOUCHER_DETAIL'
  | 'WA_ENTER_PAYMENT_PHONE'

export interface BundleOption {
  id: string
  size: string
  price: number
}

export interface USSDSession {
  step: USSDStep
  dialingPhone?: string
  network?: string           // 'MTN' | 'Telecel' | 'AirtelTigo' | 'AT-iShare'
  paystackProvider?: string  // 'mtn' | 'vod' | 'tgo'
  bundleId?: string
  bundleSize?: string
  bundlePrice?: number
  bundlePage?: number        // 0-indexed, 5 bundles per page
  bundleCache?: BundleOption[] // current page of bundles cached for selection
  bundleTotal?: number       // total bundle count for this network
  recipientPhone?: string
  effectivePriceTier?: string       // 'dealer' | 'regular' | 'sub_agent'
  subAgentParentShopId?: string     // set when user is a sub_agent; parent shop for catalog lookup
  userId?: string                   // registered user's DB id (if phone matched a user)
  walletBalance?: number            // fetched at network selection for display; re-verified at payment
  pendingOrderId?: string  // order created at CONFIRM; used by PAYMENT_METHOD + SUBMIT_OTP
  pendingOrderTable?: 'airtime_orders' | 'results_checker_orders' // which table SUBMIT_OTP targets (data bundles default to ussd_orders)
  // AFA registration fields
  afaFullName?: string
  afaGhCard?: string
  afaLocation?: string
  afaRegion?: string
  afaOrderId?: string
  afaPrice?: number
  // Airtime fields
  airtimeRecipient?: string   // beneficiary (local 0XXXXXXXXX)
  airtimeNetwork?: string     // 'MTN' | 'Telecel' | 'AT'
  airtimeAmount?: number      // total the caller pays (fee inclusive)
  airtimeToDeliver?: number   // amount the recipient receives (amount − fee)
  airtimeFee?: number
  // Results Checker fields
  rcBoard?: string            // 'WAEC' | 'BECE' | 'NOVDEC'
  rcQty?: number
  rcUnitPrice?: number
  rcTotal?: number
  rcBoardOptions?: string[]   // boards shown on the SELECT_BOARD menu, in order
  rcMyOrders?: Array<{ id: string; exam_board: string; reference_code: string; created_at: string }>
  rcSelectedOrderId?: string
  // WhatsApp-only: MoMo billing number entered by the user at WA_ENTER_PAYMENT_PHONE step
  momoPhone?: string
}
