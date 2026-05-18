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
  | 'SUBMIT_OTP'
  | 'CHECK_STATUS'
  | 'AFA_ENTER_NAME'
  | 'AFA_ENTER_CARD'
  | 'AFA_ENTER_LOCATION'
  | 'AFA_ENTER_REGION'
  | 'AFA_CONFIRM_AFA'

export interface BundleOption {
  id: string
  size: string
  price: number
}

export interface USSDSession {
  step: USSDStep
  dialingPhone?: string
  network?: string           // 'MTN' | 'Telecel' | 'AirtelTigo' | 'AT-iShare'
  paystackProvider?: string  // 'mtn' | 'vod' | 'atl'
  bundleId?: string
  bundleSize?: string
  bundlePrice?: number
  bundlePage?: number        // 0-indexed, 5 bundles per page
  bundleCache?: BundleOption[] // current page of bundles cached for selection
  bundleTotal?: number       // total bundle count for this network
  recipientPhone?: string
  effectivePriceTier?: string       // 'dealer' | 'regular' | 'sub_agent'
  subAgentParentShopId?: string     // set when user is a sub_agent; parent shop for catalog lookup
  pendingOrderId?: string  // set when Paystack returns send_otp; used by SUBMIT_OTP step
  // AFA registration fields
  afaFullName?: string
  afaGhCard?: string
  afaLocation?: string
  afaRegion?: string
  afaOrderId?: string
  afaPrice?: number
}
