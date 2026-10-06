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

export type HubtelStep = "MAIN" | "SELECT_NETWORK" | "SELECT_BUNDLE" | "ENTER_RECIPIENT" | "CONFIRM"

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

export interface HubtelTxStore {
  findBySession(sessionId: string): Promise<HubtelTxRow | null>
  /** Atomically moves awaiting_payment → processing. true only for the caller that won. */
  claim(sessionId: string, from?: HubtelTxState[]): Promise<boolean>
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
