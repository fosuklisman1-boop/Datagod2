import type { FailureReason } from "./failure-reason"

export type OrderType = "bulk" | "shop" | "api" | "ussd" | "ussd_shop"
export type QueueView = "needs_action" | "held" | "stuck" | "failed" | "all"

export const QUEUE_VIEWS: readonly QueueView[] = ["needs_action", "held", "stuck", "failed", "all"]
export const ORDER_TYPES: readonly OrderType[] = ["bulk", "shop", "api", "ussd", "ussd_shop"]

export type QueueParams = {
  view: QueueView
  statuses: string[]
  networks: string[]
  types: OrderType[]
  from: string | null
  to: string | null
  search: string
  lastProvider: string | null
  failureReason: FailureReason | null
  limit: number
  offset: number
}

// admin_order_queue RETURNS TABLE columns, camelCased (total_count is dropped; the route takes totals from the counts RPC).
export type QueueRow = {
  id: string
  createdAt: string
  phoneNumber: string | null
  price: number | null
  network: string | null
  status: string | null
  paymentStatus: string | null
  paymentReference: string | null
  volumeGb: string | null
  type: string | null
  customerEmail: string | null
  storeName: string | null
  shopOwnerEmail: string | null
  lastProvider: string | null
  lastAttemptStatus: string | null
  lastError: string | null
  attemptCount: number
  hasReversal: boolean
  isHeld: boolean
  failureReason: FailureReason | null
}
