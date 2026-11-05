import type { OrderSource } from "@/lib/admin-users/drawer-params"

export interface Paged<T> {
  rows: T[]
  total: number
  page: number
  pageSize: number
}

export interface DrawerProfile {
  id: string
  email: string
  phoneNumber: string
  firstName: string | null
  lastName: string | null
  role: string
  pricingMode: string
  isSuspended: boolean
  suspension: { reason: string | null; at: string } | null
  phoneVerified: boolean
  phoneVerifyDeadline: string | null
  createdAt: string | null
  lastSignInAt: string | null
  emailConfirmedAt: string | null
  hasProfile: boolean
  walletBalance: number
  /** Number of wallet rows; more than one is a data problem. */
  walletRows: number
}

export interface NoteItem {
  id: string
  user_id: string
  author_id: string | null
  author_email: string | null
  body: string
  created_at: string
  updated_at: string
}

export interface OrderRow {
  source: OrderSource
  id: string
  reference: string | null
  description: string | null
  recipient: string | null
  amount: number | null
  status: string | null
  /** The table's payment_status where payment happens outside the wallet (standard, bills, results), else null. */
  payment_status: string | null
  created_at: string | null
}
export interface OrdersResponse extends Paged<OrderRow> {
  totalCapped: boolean
  hasMore: boolean
  counts: Partial<Record<OrderSource, number>>
  cappedSources: OrderSource[]
  countCap: number
}

export interface TxRow {
  id: string
  type: string
  amount: number
  status: string | null
  description: string | null
  reference_id: string | null
  source: string | null
  balance_before: number | null
  balance_after: number | null
  created_at: string
}
export interface TxResponse extends Paged<TxRow> {
  wallet: { balance: number; totalCredited: number; totalSpent: number; rows: number } | null
}

export interface AuditRow {
  id: string
  /** NULL once that admin account has been deleted (0151). */
  admin_id: string | null
  admin_email: string | null
  action: string
  old_value: Record<string, unknown> | null
  new_value: Record<string, unknown> | null
  created_at: string
}

export interface SubAgentRow {
  shop_id: string
  user_id: string
  email: string | null
  shop_name: string
  shop_slug: string
  created_at: string
}
export interface WithdrawalRow {
  id: string
  amount: number
  fee_amount: number | null
  net_amount: number | null
  status: string
  withdrawal_method: string | null
  reference_code: string | null
  created_at: string
}
export interface ShopResponse {
  shop: {
    id: string
    shop_name: string
    shop_slug: string
    is_active: boolean | null
    created_at: string
    customers: number
    balance: { available: number; totalProfit: number; withdrawn: number; pending: number; credited: number }
  } | null
  parent: { id: string; shop_name: string; shop_slug: string; user_id: string } | null
  subAgents: Paged<SubAgentRow>
  withdrawals: Paged<WithdrawalRow>
}
