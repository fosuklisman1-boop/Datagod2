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
  // Results Check Service (check results on behalf of user)
  | 'RC_CHECK_BOARD'
  | 'RC_CHECK_CANDIDATE_TYPE'
  | 'RC_CHECK_MODE'
  | 'RC_CHECK_VOUCHER'
  | 'RC_CHECK_INDEX'
  | 'RC_CHECK_DOB'
  | 'RC_CHECK_WA_NUMBER'
  | 'RC_CHECK_YEAR'
  | 'RC_CHECK_PAYMENT_METHOD'
  | 'RC_CHECK_CONFIRM'
  | 'WA_ENTER_PAYMENT_PHONE'
  // WhatsApp admin: results-check delivery
  | 'ADMIN_RC_LIST'
  | 'ADMIN_RC_AWAIT_CONTENT'
  // WhatsApp admin: complaints queue
  | 'ADMIN_COMPLAINT_LIST'
  | 'ADMIN_COMPLAINT_AWAIT_REPLY'
  // Network Plans (commission cashback bots; shared with the shop menu)
  | UzoNpStep

/** Network Plans steps (lib/ussd/bots/network-plans.ts), used by the main AND the shop USSD menus. */
export type UzoNpStep = 'NP_NETWORK' | 'NP_CATEGORY' | 'NP_PLAN' | 'NP_RECIPIENT' | 'NP_CONFIRM'

/** One plan as kept in the session: the engine's signed catalog token plus what the screen showed. */
export interface UzoNpPlan {
  t: string  // engine catalog token (signed; the engine re-prices from it)
  d: string  // plan text as Hubtel sends it (rewritten only when shown)
  f: number  // face amount
  p: number  // price shown = expectedPay (the engine 409s when the live price differs)
}

/** Network Plans session fields (shared by USSDSession and USSDShopSession). */
export interface UzoNpSessionFields {
  npNetwork?: 'MTN' | 'TELECEL' | 'AT'
  npCategories?: string[]    // category names as the catalog sends them, in screen order
  npCategory?: string
  npPage?: number            // 0-indexed page of the plan list
  npPlans?: UzoNpPlan[]      // the plans on the page last shown
  npPlan?: UzoNpPlan         // the chosen plan
  npOtherNumber?: boolean    // recipient step is waiting for a typed number
  npRecipient?: string       // local 0XXXXXXXXX
}

export interface BundleOption {
  id: string
  size: string
  price: number
}

export interface USSDSession extends UzoNpSessionFields {
  step: USSDStep
  dialingPhone?: string
  dataBlocked?: boolean        // true when whitelist is ON and caller is not a registered user
  mtnWhitelistActive?: boolean // true when active MTN provider requires whitelist (xpress/codecraft)
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
  pendingOrderTable?: 'airtime_orders' | 'results_checker_orders' | 'results_check_requests' // which table SUBMIT_OTP targets (data bundles default to ussd_orders)
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
  airtimeCashbackPay?: number // cashback applied (Uzo USSD only): price shown = charged (quote.payAmount); airtimeAmount is then the face
  airtimeCashbackWalletPay?: number // cashback applied: dealer-wallet price (quote.base, no Paystack fee)
  // Results Checker fields
  rcBoard?: string            // 'WASSCE' | 'BECE' | 'NOVDEC'
  rcQty?: number
  rcUnitPrice?: number
  rcTotal?: number
  rcBoardOptions?: string[]   // boards shown on the SELECT_BOARD menu, in order
  rcMyOrders?: Array<{ id: string; exam_board: string; reference_code: string; created_at: string }>
  rcSelectedOrderId?: string
  // Results Check Service fields
  rcCheckBoard?: string                       // 'WASSCE' | 'BECE' | 'NOVDEC'
  rcCheckCandidateType?: 'school' | 'private'
  rcCheckMode?: 'combo' | 'own_voucher'
  rcCheckVoucherPin?: string                  // PIN the user provides (own_voucher mode)
  rcCheckVoucherSerial?: string               // serial number the user provides (own_voucher mode)
  rcCheckIndex?: string                       // student's index number
  rcCheckDob?: string                         // date of birth DD/MM/YYYY
  rcCheckYear?: number                        // exam year e.g. 2024
  rcCheckFee?: number                         // check-only fee from admin settings
  rcCheckComboTotal?: number                  // combo total: 1 voucher price + check fee
  rcCheckChannel?: 'ussd' | 'whatsapp'
  rcCheckWaNumber?: string                    // WhatsApp contact for USSD users (optional)
  // WhatsApp-only: MoMo billing number entered by the user at WA_ENTER_PAYMENT_PHONE step
  momoPhone?: string
  // WhatsApp-only: handler key to invoke after WA_ENTER_PAYMENT_PHONE for direct-charge confirm paths
  waNextStep?: string
  // Admin WhatsApp results-check delivery
  adminRcRequestIds?: string[]    // ids shown by the "pending" list, in display order (1-based)
  adminRcSelectedId?: string      // claimed request id, set at ADMIN_RC_AWAIT_CONTENT
  adminRcDraftText?: string       // accumulated result text typed by the admin
  adminRcDraftMediaUrl?: string   // public admin-uploads URL after a photo/PDF is received
  adminRcDraftMediaType?: 'image' | 'document'
  // Admin WhatsApp complaints queue
  adminComplaintIds?: string[]    // ids shown by the "complaints" list, in display order (1-based)
  adminComplaintSelectedId?: string // claimed complaint id, set at ADMIN_COMPLAINT_AWAIT_REPLY
}
