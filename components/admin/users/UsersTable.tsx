"use client"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { AlertCircle, ArrowDown, ArrowUp, ArrowUpDown, Eye, Loader2, Shield } from "lucide-react"
import type { SortDir, UserSort } from "@/lib/admin-users/list-params"
import type { AdminUser } from "./types"

const COLUMN_COUNT = 12

interface UsersTableProps {
  users: AdminUser[]
  loading: boolean
  /** Filters or search are narrowing the list (changes the empty-state text). */
  filtered: boolean
  sort: UserSort
  dir: SortDir
  onSort: (sort: UserSort) => void
  /** Selected row ids (auth user ids). Survives paging; the page clears it when filters change. */
  selectedIds: ReadonlySet<string>
  onToggleSelected: (id: string, selected: boolean) => void
  onToggleAllOnPage: (selected: boolean) => void
  onView: (user: AdminUser) => void
  onBalance: (user: AdminUser) => void
  onAccountActions: (user: AdminUser) => void
  onCustomPrices: (user: AdminUser) => void
}

function SortHeader({ label, column, sort, dir, onSort }: { label: string; column: UserSort; sort: UserSort; dir: SortDir; onSort: (s: UserSort) => void }) {
  const active = sort === column
  const Icon = !active ? ArrowUpDown : dir === "asc" ? ArrowUp : ArrowDown
  return (
    <th
      className="px-6 py-3 text-left text-sm font-semibold text-foreground"
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className="inline-flex items-center gap-1 hover:text-primary"
        title={`Sort by ${label.toLowerCase()}`}
      >
        {label}
        <Icon className={`w-3.5 h-3.5 ${active ? "text-primary" : "text-muted-foreground"}`} />
      </button>
    </th>
  )
}

const Th = ({ children }: { children: React.ReactNode }) => (
  <th className="px-6 py-3 text-left text-sm font-semibold text-foreground">{children}</th>
)

export function UsersTable({
  users, loading, filtered, sort, dir, onSort, selectedIds, onToggleSelected, onToggleAllOnPage,
  onView, onBalance, onAccountActions, onCustomPrices,
}: UsersTableProps) {
  const selectedOnPage = users.filter((u) => selectedIds.has(u.id)).length
  const allOnPage = users.length > 0 && selectedOnPage === users.length
  const sortProps = { sort, dir, onSort }

  return (
    <div className="relative overflow-x-auto rounded-md border border-border">
      <table className={`min-w-[600px] w-full text-xs sm:text-sm transition-opacity ${loading && users.length ? "opacity-60" : ""}`} aria-busy={loading}>
        <thead className="bg-card backdrop-blur border-b border-border">
          <tr>
            <th className="px-3 py-3 text-left">
              <Checkbox
                aria-label="Select all users on this page"
                checked={allOnPage ? true : selectedOnPage > 0 ? "indeterminate" : false}
                onCheckedChange={(c) => onToggleAllOnPage(c === true)}
                disabled={users.length === 0}
              />
            </th>
            <SortHeader label="Email" column="email" {...sortProps} />
            <Th>Phone</Th>
            <Th>Role</Th>
            <SortHeader label="Wallet Balance" column="balance" {...sortProps} />
            <SortHeader label="Shop Balance" column="shop_balance" {...sortProps} />
            <Th>Shop</Th>
            <Th>Total Customers</Th>
            <Th>Sub-Agents</Th>
            <SortHeader label="Joined" column="created_at" {...sortProps} />
            <SortHeader label="Last Sign-in" column="last_sign_in_at" {...sortProps} />
            <Th>Actions</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {users.length === 0 ? (
            <tr>
              <td colSpan={COLUMN_COUNT} className="px-6 py-8 text-center text-muted-foreground">
                {loading ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading users...
                  </span>
                ) : filtered ? "No users found matching your search or filters" : "No users found"}
              </td>
            </tr>
          ) : (
            users.map((user) => (
              <tr
                key={user.id}
                data-user-id={user.id}
                className={`hover:bg-muted backdrop-blur transition-colors ${selectedIds.has(user.id) ? "bg-primary/5" : ""}`}
              >
                <td className="px-3 py-4">
                  <Checkbox
                    aria-label={`Select ${user.email}`}
                    checked={selectedIds.has(user.id)}
                    onCheckedChange={(c) => onToggleSelected(user.id, c === true)}
                  />
                </td>
                <td className="px-6 py-4 font-medium text-foreground">{user.email}</td>
                <td className="px-6 py-4 text-sm text-muted-foreground">{user.phoneNumber || "-"}</td>
                <td className="px-6 py-4 flex flex-col gap-1">
                  <Badge className={user.role === "admin" ? "bg-destructive" : "bg-primary"}>
                    {user.role}
                  </Badge>
                  {user.pricing_mode === "custom" && <Badge variant="outline">Custom pricing</Badge>}
                  {user.is_suspended && (
                    <Badge className="bg-destructive text-primary-foreground mt-1">
                      Suspended
                    </Badge>
                  )}
                </td>
                <td className="px-6 py-4 font-semibold text-primary">GHS {(user.walletBalance || 0).toFixed(2)}</td>
                <td className="px-6 py-4 font-semibold text-success">GHS {(user.shopBalance || 0).toFixed(2)}</td>
                <td className="px-6 py-4 text-sm text-muted-foreground">{user.shop?.shop_name || "No shop"}</td>
                <td className="px-6 py-4 text-sm text-muted-foreground">
                  <Badge className="bg-primary">
                    {user.customerCount || 0}
                  </Badge>
                </td>
                <td className="px-6 py-4 text-sm text-muted-foreground">
                  <Badge className="bg-primary">
                    {user.subAgentCount || 0}
                  </Badge>
                </td>
                <td className="px-6 py-4 text-sm text-muted-foreground">{new Date(user.created_at).toLocaleDateString()}</td>
                <td className="px-6 py-4 text-sm text-muted-foreground">
                  {user.last_sign_in_at ? new Date(user.last_sign_in_at).toLocaleDateString() : "Never"}
                </td>
                <td className="px-6 py-4 flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onView(user)}
                    className="text-success hover:text-success hover:bg-success/10"
                    title="Details & statistics"
                  >
                    <Eye className="w-4 h-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onBalance(user)}
                    className="text-primary hover:text-primary hover:bg-primary/5"
                    title="Manage balance"
                  >
                    <Shield className="w-4 h-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onAccountActions(user)}
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    title="Suspend or delete"
                  >
                    <AlertCircle className="w-4 h-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onCustomPrices(user)}
                  >
                    Custom prices
                  </Button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

interface UsersPaginationProps {
  page: number
  pageSize: number
  total: number
  loading: boolean
  onPage: (page: number) => void
}

export function UsersPagination({ page, pageSize, total, loading, onPage }: UsersPaginationProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1
  const last = Math.min(page * pageSize, total)
  return (
    <div className="flex flex-col gap-2 pt-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {total === 0 ? "No users" : `Showing ${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()}`}
        {loading && <Loader2 className="ml-2 inline w-3.5 h-3.5 animate-spin" />}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => onPage(1)} disabled={page <= 1 || loading}>
          First
        </Button>
        <Button variant="outline" size="sm" onClick={() => onPage(page - 1)} disabled={page <= 1 || loading}>
          Previous
        </Button>
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          Page {page.toLocaleString()} of {pageCount.toLocaleString()}
        </span>
        <Button variant="outline" size="sm" onClick={() => onPage(page + 1)} disabled={page >= pageCount || loading}>
          Next
        </Button>
        <Button variant="outline" size="sm" onClick={() => onPage(pageCount)} disabled={page >= pageCount || loading}>
          Last
        </Button>
      </div>
    </div>
  )
}
