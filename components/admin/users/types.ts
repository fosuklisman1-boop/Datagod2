import type { AdminUserListItem } from "@/lib/admin-users/list-params"

/** A row of the admin users list. `id` (the auth user id) is the stable row key. */
export type AdminUser = AdminUserListItem

export interface UserStats {
  userId: string
  wallet: {
    balance: number
    totalTopUps: number
    totalSpent: number
    transactionCount: number
  }
  orders: {
    total: number
    completed: number
    failed: number
    pending: number
  }
  shop: {
    shopId: string
    shopName: string
    shopSlug: string
    createdAt: string
    totalOrders: number
    paidOrders: number
    completedOrders: number
    totalSales: number
    totalProfit: number
    availableBalance: number
    withdrawnAmount: number
    pendingProfit: number
    creditedProfit: number
    profitRecords: number
  } | null
  withdrawals: {
    history: Array<{
      id: string
      amount: number
      feeAmount: number
      netAmount: number
      status: string
      method: string
      createdAt: string
      referenceCode: string
    }>
    totalWithdrawn: number
    pendingCount: number
    completedCount: number
  }
}

// Format large numbers with K/M suffix
export const formatCount = (num: number): string => {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M'
  }
  if (num >= 10000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
  }
  return num.toLocaleString()
}
