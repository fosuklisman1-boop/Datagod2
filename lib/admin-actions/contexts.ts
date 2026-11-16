import type { FlowId } from "./types"

export interface WithdrawalCtx {
  withdrawalId: string
  amount: number
  shopName?: string | null
  method?: string | null
  phone?: string | null
  reason?: string | null
  remainingBalance?: string | null
}
export interface AfaCtx {
  orderCode: string
  fullName: string
  reason?: string | null
}
export interface ResultsCheckCtx {
  requestId: string
  examBoard: string
  indexNumber: string
  examYear?: string | number | null
  channel?: string | null
  shopName?: string | null
  reason?: string | null
}
export interface ShopCtx {
  shopId: string
  shopName: string
  reason?: string | null
  ownerPhone?: string | null
}
export interface SenderIdCtx {
  senderIdId: string
  senderId: string
  reason?: string | null
}
export interface ComplaintCtx {
  complaintId: string
  orderId?: string | null
  priority?: string | null
  summary?: string | null
  resolutionNotes?: string | null
  /** Optional admin deep link (must start with /admin/; otherwise ignored). */
  url?: string
  /** Optional complainant label (e.g. WhatsApp name/number) shown in the alert. */
  customerLabel?: string | null
}

export interface MomoClaimCtx {
  kind: "credited" | "flagged" | "unparsed" | "reconciliation_missing" | "setting_changed"
  amountPesewas?: number
  /** Last 4 digits only; the full transaction ID must never reach an alert. */
  txidLast4?: string
  reasons?: string[]
}

export interface TextToBuyCtx {
  kind: "setting_changed"
  /** Names of the settings that changed (admin_settings keys). Never their values, never a phone number. */
  keys: string[]
}

export interface FlowCtx {
  withdrawal: WithdrawalCtx
  afa: AfaCtx
  results_check: ResultsCheckCtx
  shop: ShopCtx
  sender_id: SenderIdCtx
  complaint: ComplaintCtx
  momo_claim: MomoClaimCtx
  text_to_buy: TextToBuyCtx
}
export type _FlowCtxKeysMatchFlowId = keyof FlowCtx extends FlowId ? (FlowId extends keyof FlowCtx ? true : never) : never
