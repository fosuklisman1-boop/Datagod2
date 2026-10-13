export type HubtelCsKind = "airtime" | "data" | "bill"
export type HubtelCsState = "created" | "pending" | "fulfilled" | "failed" | "needs_review"

/** One row of hubtel_cs_transactions (snake_case, exactly as PostgREST returns it). */
export interface HubtelCsTx {
  id: string
  client_reference: string
  service_key: string
  kind: HubtelCsKind
  destination: string
  amount: number
  bundle: string | null
  extra: Record<string, unknown> | null
  state: HubtelCsState
  response_code: string | null
  response_message: string | null
  failure_reason: string | null
  hubtel_transaction_id: string | null
  external_transaction_id: string | null
  commission: number | null
  charges: number | null
  amount_debited: number | null
  order_table: string | null
  order_id: string | null
  submitted_at: string | null
  completed_at: string | null
  callback_received_at: string | null
  status_check_attempts: number
  negative_checks: number
  last_status_check_at: string | null
  review_reason: string | null
  resolved_by: string | null
  resolved_at: string | null
  resolution_note: string | null
  refund_claimed_at: string | null
  refund_claimed_by: string | null
  created_at: string
  updated_at: string
}

export type HubtelCsPatch = Partial<Omit<HubtelCsTx, "id" | "client_reference" | "created_at">>

export type NewHubtelCsTx = Pick<HubtelCsTx, "client_reference" | "service_key" | "kind" | "destination" | "amount"> &
  Partial<Pick<HubtelCsTx, "bundle" | "extra" | "order_table" | "order_id">>

export interface HubtelCsEvent {
  client_reference: string | null
  direction: "request" | "response" | "callback" | "status_check"
  http_status?: number | null
  ok?: boolean | null
  payload?: unknown
  error?: string | null
  source_ip?: string | null
}

/** A Hubtel final-callback body, normalised. */
export interface ParsedCallback {
  responseCode: string
  clientReference: string
  transactionId: string | null
  externalTransactionId: string | null
  description: string | null
  amountDebited: number | null
  charges: number | null
  commission: number | null
}

/** One entry of a Hubtel query response `Data` array. */
export interface HubtelQueryItem {
  Display: string
  Value: string
  Amount: number
}
