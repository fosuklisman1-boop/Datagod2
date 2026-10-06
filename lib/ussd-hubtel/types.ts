export type HubtelPlatform = "USSD" | "Webstore" | "Hubtel-App"
export type HubtelRequestType = "Initiation" | "Response" | "Timeout"
export type HubtelFieldType = "text" | "phone" | "email" | "number" | "decimal" | "textarea"

/** Normalised inbound Service Interaction request. */
export interface HubtelRequest {
  Type: HubtelRequestType
  Mobile: string
  SessionId: string
  ServiceCode: string
  Message: string
  Operator: string
  Sequence: number
  ClientState: string
  Platform: HubtelPlatform
}

export interface HubtelReply {
  SessionId: string
  Type: "response" | "release" | "AddToCart"
  Message: string
  Label: string
  DataType: "display" | "input"
  FieldType: HubtelFieldType
  ClientState?: string
  Item?: { ItemName: string; Qty: number; Price: number }
}

export type HubtelStep =
  | "MAIN" | "SELECT_NETWORK" | "SELECT_BUNDLE" | "ENTER_RECIPIENT" | "CONFIRM"
  | "AIRTIME_ENTER_RECIPIENT" | "AIRTIME_SELECT_NETWORK" | "AIRTIME_ENTER_AMOUNT" | "AIRTIME_CONFIRM"
  | "RC_MENU" | "RC_SELECT_BOARD" | "RC_ENTER_QTY" | "RC_CONFIRM" | "RC_MY_VOUCHERS" | "RC_VOUCHER_DETAIL"
  | "RC_CHECK_BOARD" | "RC_CHECK_CANDIDATE_TYPE" | "RC_CHECK_MODE" | "RC_CHECK_VOUCHER" | "RC_CHECK_INDEX"
  | "RC_CHECK_YEAR" | "RC_CHECK_DOB" | "RC_CHECK_WA_NUMBER" | "RC_CHECK_CONFIRM"
  | "AFA_ENTER_NAME" | "AFA_ENTER_CARD" | "AFA_ENTER_LOCATION" | "AFA_ENTER_REGION" | "AFA_CONFIRM"

export interface HubtelSession {
  step: HubtelStep
  dialingPhone: string // E.164-style, e.g. +233200585542
  platform: HubtelPlatform
  dataBlocked?: boolean
  network?: string // packages.network value: MTN | Telecel | AT-iShare | AT-BigTime
  effectivePriceTier?: string // regular | dealer | sub_agent
  subAgentParentShopId?: string
  userId?: string
  bundlePage?: number
  bundleId?: string
  bundleSize?: string
  bundlePrice?: number
  recipientPhone?: string // local 0XXXXXXXXX
  // Airtime
  airtimeRecipient?: string // local 0XXXXXXXXX
  airtimeNetwork?: "MTN" | "Telecel" | "AT"
  airtimeAmount?: number // what the caller pays = order total_paid = Hubtel Price
  airtimeFee?: number
  airtimeToDeliver?: number // what the recipient gets (amount - fee)
  // Results checker (buy / my vouchers)
  rcBoardOptions?: string[] // boards shown on RC_SELECT_BOARD, in order
  rcBoard?: string // WASSCE | BECE | NOVDEC
  rcQty?: number
  rcUnitPrice?: number
  rcTotal?: number // = order total_paid = Hubtel Price
  rcBulkApplied?: boolean
  rcMyOrders?: Array<{ id: string; exam_board: string; reference_code: string; created_at: string }>
  rcSelectedOrderId?: string
  // Results check service (Datagod checks results on the caller's behalf)
  rcCheckBoard?: string // WASSCE | BECE | NOVDEC
  rcCheckCandidateType?: "school" | "private"
  rcCheckMode?: "combo" | "own_voucher"
  rcCheckVoucherPin?: string
  rcCheckVoucherSerial?: string
  rcCheckIndex?: string
  rcCheckYear?: number
  rcCheckDob?: string // DD/MM/YYYY
  rcCheckWaNumber?: string // local 0XXXXXXXXX
  rcCheckFee?: number // check-only fee
  rcCheckComboTotal?: number // one voucher + fee; undefined when combo is not offered
  // AFA registration
  afaFullName?: string
  afaGhCard?: string // normalised GHA-XXXXXXXXX-X
  afaLocation?: string
  afaRegion?: string
  afaPrice?: number // = order amount = Hubtel Price
}

export type HubtelTxState = "awaiting_payment" | "processing" | "fulfilled" | "needs_review" | "failed"
export type HubtelCallbackStatus = "not_due" | "pending" | "sent" | "failed"

export interface HubtelTxRow {
  session_id: string
  hubtel_order_id: string | null
  platform: string
  order_table: string
  order_id: string
  mobile: string | null
  expected_amount: number | string
  amount_paid: number | null
  amount_after_charges: number | null
  state: HubtelTxState
  callback_status: HubtelCallbackStatus
  callback_attempts: number
  callback_last_error: string | null
  callback_sent_at: string | null
  status_check_attempts: number
  last_status_check_at: string | null
  paid_at: string | null
  created_at: string
  updated_at: string
}

export interface HubtelClaimGuard {
  callback_status?: HubtelCallbackStatus
  paid_atIsNull?: boolean
}

export interface HubtelTxStore {
  findBySession(sessionId: string): Promise<HubtelTxRow | null>
  /**
   * Atomically moves a row in one of `from` (default awaiting_payment) → processing. true only for
   * the caller that won. `where` adds guards so a claim only wins on a row still in that exact shape.
   */
  claim(sessionId: string, from?: HubtelTxState[], where?: HubtelClaimGuard): Promise<boolean>
  update(sessionId: string, patch: Partial<HubtelTxRow>): Promise<void>
  listPendingCallbacks(limit: number): Promise<HubtelTxRow[]>
  listAwaitingPayment(limit: number): Promise<HubtelTxRow[]>
  listStaleProcessing(olderThanMinutes: number, limit: number): Promise<HubtelTxRow[]>
  /** Rows parked by an indeterminate expiry check: needs_review + callback not_due + paid_at null, oldest first. */
  listIndeterminate(limit: number): Promise<HubtelTxRow[]>
}

/** What we extract from a fulfilment webhook or a status-check "Paid" response. */
export interface HubtelFulfillmentInfo {
  sessionId: string
  hubtelOrderId: string | null
  amountPaid: number
  amountAfterCharges: number
  isSuccessful: boolean
}
