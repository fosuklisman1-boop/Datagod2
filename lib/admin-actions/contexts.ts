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
}

export interface FlowCtx {
  withdrawal: WithdrawalCtx
  afa: AfaCtx
  results_check: ResultsCheckCtx
  shop: ShopCtx
  sender_id: SenderIdCtx
  complaint: ComplaintCtx
}
export type _FlowCtxKeysMatchFlowId = keyof FlowCtx extends FlowId ? (FlowId extends keyof FlowCtx ? true : never) : never
