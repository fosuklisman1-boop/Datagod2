import type { AdminUserListItem } from "@/lib/admin-users/list-params"

/** A row of the admin users list. `id` (the auth user id) is the stable row key. */
export type AdminUser = AdminUserListItem

/** The fields the per-user dialogs need. A list row (AdminUser) and the drawer's profile both provide them. */
export interface UserRef {
  id: string
  email: string
}
export interface WalletTarget extends UserRef {
  walletBalance: number
}
export interface AccountTarget extends UserRef {
  is_suspended: boolean
}
export type DialogUser = WalletTarget & AccountTarget

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
