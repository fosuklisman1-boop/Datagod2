import { supabase } from "./supabase"
import { refreshUserSession } from "./session-refresh"
import {
  listParamsToSearchParams,
  type AdminUserListItem,
  type UsersListFilters,
  type UsersListParams,
  type UsersListResponse,
} from "./admin-users/list-params"
import { exportAllUsers } from "./admin-users/export-client"
import { adminJson } from "./admin-users/drawer-client"

// Admin Package Management
export const adminPackageService = {
  // Get all packages
  async getAllPackages() {
    const { data, error } = await supabase
      .from("packages")
      .select("*")
      .order("created_at", { ascending: false })

    if (error) throw error
    return data
  },

  // Create new package
  async createPackage(packageData: {
    network: string
    size: string
    price: number
    dealer_price?: number | null
    description?: string
  }) {
    try {
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.access_token) {
        throw new Error("No authentication token available")
      }

      const response = await fetch("/api/admin/packages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ packageData, isUpdate: false }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to create package")
      }

      return data.data
    } catch (error: any) {
      console.error("Error creating package:", error)
      throw error
    }
  },

  // Update package
  async updatePackage(packageId: string, updates: any) {
    try {
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.access_token) {
        throw new Error("No authentication token available")
      }

      const response = await fetch("/api/admin/packages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ packageData: updates, packageId, isUpdate: true }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to update package")
      }

      return data.data
    } catch (error: any) {
      console.error("Error updating package:", error)
      throw error
    }
  },

  // Delete package
  async deletePackage(packageId: string) {
    try {
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.access_token) {
        throw new Error("No authentication token available")
      }

      const response = await fetch("/api/admin/packages/delete", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ packageId }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to delete package")
      }

      return { success: true }
    } catch (error: any) {
      console.error("Error deleting package:", error)
      throw error
    }
  },

  // Bulk update price and/or dealer_price for many packages at once
  async bulkUpdatePrices(
    packageIds: string[],
    updates: import("./bulk-package-pricing").BulkPriceUpdates
  ) {
    try {
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.access_token) {
        throw new Error("No authentication token available")
      }

      const response = await fetch("/api/admin/packages/bulk-update-price", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ packageIds, updates }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to bulk update prices")
      }

      return data as {
        updated: import("./bulk-package-pricing").PackagePriceResult[]
        skipped: (Omit<import("./bulk-package-pricing").PackagePriceResult, "skip_reason"> & {
          skip_reason: import("./bulk-package-pricing").SkipReason | "write_failed"
        })[]
        not_found: string[]
      }
    } catch (error: any) {
      console.error("Error bulk updating package prices:", error)
      throw error
    }
  },

  // Get the current per-network out-of-stock status map
  async getNetworkStock(): Promise<import("./network-stock-service").NetworkStockMap> {
    try {
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.access_token) {
        throw new Error("No authentication token available")
      }

      const response = await fetch("/api/admin/packages/network-stock", {
        headers: {
          "Authorization": `Bearer ${session.access_token}`,
        },
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to fetch network stock status")
      }

      return data.status
    } catch (error: any) {
      console.error("Error fetching network stock status:", error)
      throw error
    }
  },

  // Mark a network out of stock (disables all its currently-available
  // packages) or restock it (re-enables exactly the packages that were
  // disabled by the last out-of-stock toggle)
  async setNetworkStock(network: string, outOfStock: boolean): Promise<{ success: boolean; affected: number }> {
    try {
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.access_token) {
        throw new Error("No authentication token available")
      }

      const response = await fetch("/api/admin/packages/network-stock", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ network, outOfStock }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to update network stock status")
      }

      return data
    } catch (error: any) {
      console.error("Error updating network stock status:", error)
      throw error
    }
  },
}

// Admin USSD Menu Service Visibility
export const adminUssdService = {
  // Get the current top-level USSD menu service visibility map
  async getServiceVisibility(): Promise<import("./ussd-service-visibility").UssdServiceVisibility> {
    try {
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.access_token) {
        throw new Error("No authentication token available")
      }

      const response = await fetch("/api/admin/ussd/service-visibility", {
        headers: {
          "Authorization": `Bearer ${session.access_token}`,
        },
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to fetch USSD service visibility")
      }

      return data.status
    } catch (error: any) {
      console.error("Error fetching USSD service visibility:", error)
      throw error
    }
  },

  // Flip one service's visibility on the top-level USSD menu (main + shop storefront)
  async setServiceVisibility(
    service: string,
    visible: boolean
  ): Promise<{ success: boolean; status: import("./ussd-service-visibility").UssdServiceVisibility }> {
    try {
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.access_token) {
        throw new Error("No authentication token available")
      }

      const response = await fetch("/api/admin/ussd/service-visibility", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ service, visible }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to update USSD service visibility")
      }

      return data
    } catch (error: any) {
      console.error("Error updating USSD service visibility:", error)
      throw error
    }
  },
}

// Admin User Management
export const adminUserService = {
  // One page of users matching the filters: { users, total, page, pageSize }
  async listUsers(params: Partial<UsersListParams> = {}, init?: { signal?: AbortSignal }): Promise<UsersListResponse> {
    const { data: { session } } = await supabase.auth.getSession()

    if (!session?.access_token) {
      throw new Error("No authentication token available")
    }

    const qs = listParamsToSearchParams(params).toString()
    const response = await fetch(`/api/admin/users${qs ? `?${qs}` : ""}`, {
      headers: {
        "Authorization": `Bearer ${session.access_token}`,
      },
      signal: init?.signal,
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw new Error(body?.error || "Failed to fetch users")
    }
    return response.json()
  },

  // Every user matching the filters (all users with no filters), oldest signup first, via the
  // keyset export endpoint (5000 per request, 429s retried). Rejects with UsersExportError rather
  // than returning a partial list.
  async getAllUsers(
    filters: Partial<UsersListFilters> = {},
    onProgress?: (loaded: number) => void,
  ): Promise<AdminUserListItem[]> {
    // sort/dir don't apply to the export (fixed created_at, id order)
    const { sort: _sort, dir: _dir, ...rest } = filters
    const qs = listParamsToSearchParams(rest)
    return exportAllUsers<AdminUserListItem>(async (cursor) => {
      // Fresh token per request: a long export can outlive an access token.
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error("No authentication token available")
      const sp = new URLSearchParams(qs)
      if (cursor) sp.set("cursor", cursor)
      const q = sp.toString()
      return fetch(`/api/admin/users/export${q ? `?${q}` : ""}`, {
        headers: { "Authorization": `Bearer ${session.access_token}` },
      })
    }, { onProgress })
  },

  // Update user role
  async updateUserRole(userId: string, role: string) {
    try {
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.access_token) {
        throw new Error("No authentication token available")
      }

      // Use the new comprehensive update-role endpoint
      const response = await fetch("/api/admin/users/update-role", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ userId, newRole: role }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || `Failed to update user role to ${role}`)
      }

      // Add note to response that user needs to refresh their session
      data.requiresSessionRefresh = true
      data.sessionRefreshMessage = `The user's role has been updated to "${role}". They will need to log out and log back in to access the new permissions.`

      return data
    } catch (error: any) {
      console.error("Error updating user role:", error)
      throw error
    }
  },

  // Credit or debit a user's wallet, with a reason. expectedBalance is the balance the admin confirmed;
  // the server refuses (409) if it has changed. Atomic and audited (admin_wallet_adjust, migrations/0171).
  async updateUserBalance(
    userId: string,
    amount: number,
    type: "credit" | "debit",
    reason: string,
    expectedBalance?: number,
  ): Promise<{ balance: number; balanceBefore: number; transactionId: string | null; referenceId: string | null }> {
    const data = await adminJson<{ data: { balance: number; balanceBefore: number; transactionId: string | null; referenceId: string | null } }>(
      "/api/admin/update-balance",
      { method: "POST", body: { userId, amount, type, reason, expectedBalance } },
    )
    return data.data
  },

  // Sign the user out of every device (deletes their auth sessions). Audited.
  async forceLogout(userId: string): Promise<{ sessionsRevoked: number; audited: boolean }> {
    return adminJson(`/api/admin/users/${userId}/force-logout`, { method: "POST", body: {} })
  },

  // Email the user the app's password reset link. Audited.
  async sendPasswordReset(userId: string): Promise<{ email: string; expiresInMinutes: number; audited: boolean }> {
    return adminJson(`/api/admin/users/${userId}/password-reset`, { method: "POST", body: {} })
  },

  // Mark the user's phone number verified or unverified (users.phone_verified). Audited.
  async setPhoneVerified(userId: string, verified: boolean): Promise<{ phoneVerified: boolean; changed: boolean; audited: boolean }> {
    return adminJson(`/api/admin/users/${userId}/phone-verified`, { method: "POST", body: { verified } })
  },

  // Toggle user suspension status
  async toggleUserSuspension(userId: string, action: "suspend" | "unsuspend", reason?: string) {
    try {
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.access_token) {
        throw new Error("No authentication token available")
      }

      const response = await fetch("/api/admin/users/suspend", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ userId, action, reason }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || `Failed to ${action} user`)
      }

      return data
    } catch (error: any) {
      console.error(`Error ${action}ing user:`, error)
      throw error
    }
  },

  // Remove user
  async removeUser(userId: string) {
    try {
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.access_token) {
        throw new Error("No authentication token available")
      }

      const response = await fetch("/api/admin/remove-user", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ userId }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to remove user")
      }

      return { success: true, message: data.message }
    } catch (error: any) {
      console.error("Error removing user:", error)
      throw error
    }
  },

  // Get user details
  async getUserDetails(userId: string) {
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("*")
      .eq("id", userId)
      .single()

    if (userError) throw userError

    const { data: shop } = await supabase
      .from("user_shops")
      .select("*")
      .eq("user_id", userId)
      .single()

    const { data: orders } = await supabase
      .from("shop_orders")
      .select("*")
      .eq("shop_id", shop?.id)

    const { data: profits } = await supabase
      .from("shop_profits")
      .select("*")
      .eq("shop_id", shop?.id)

    return {
      ...user,
      shop,
      orders: orders || [],
      profits: profits || [],
    }
  },

  // Change user password (admin only)
  // Update user profile details (email, phone, names, password)
  async updateUserDetails(userId: string, details: {
    email?: string,
    phoneNumber?: string,
    firstName?: string,
    lastName?: string,
    password?: string
  }) {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error("No authentication token available")

      const response = await fetch("/api/admin/users/update-user", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ userId, ...details }),
      })

      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to update user details")
      return data
    } catch (error: any) {
      console.error("Error updating user details:", error)
      throw error
    }
  },
  // Change user password (admin action)
  async changeUserPassword(
    userId: string,
    newPassword: string,
    session: any
  ) {
    return this.updateUserDetails(userId, { password: newPassword })
  },
}

// Admin Shop Management
export const adminShopService = {
  // Get all shops with approval status
  async getAllShops() {
    try {
      const { data: { session } } = await supabase.auth.getSession()

      const headers: HeadersInit = {}
      if (session?.access_token) {
        headers["Authorization"] = `Bearer ${session.access_token}`
      }

      const response = await fetch("/api/admin/shops?limit=500", { headers })
      if (!response.ok) {
        throw new Error("Failed to fetch shops")
      }
      const result = await response.json()
      return result.data || []
    } catch (error: any) {
      console.error("Error fetching shops:", error)
      throw error
    }
  },

  // Get pending shop approvals
  async getPendingShops() {
    try {
      const { data: { session } } = await supabase.auth.getSession()

      const headers: HeadersInit = {}
      if (session?.access_token) {
        headers["Authorization"] = `Bearer ${session.access_token}`
      }

      const response = await fetch("/api/admin/shops?status=pending", { headers })
      if (!response.ok) {
        throw new Error("Failed to fetch shops")
      }
      const result = await response.json()
      return result.data || []
    } catch (error: any) {
      console.error("Error fetching pending shops:", error)
      throw error
    }
  },

  // Recent storefront joiners (they skip approval; admins review and can block them here)
  async getStorefrontJoiners() {
    const { data: { session } } = await supabase.auth.getSession()
    const headers: HeadersInit = {}
    if (session?.access_token) {
      headers["Authorization"] = `Bearer ${session.access_token}`
    }
    const response = await fetch("/api/admin/shops?status=storefront_joiners&limit=200", { headers })
    if (!response.ok) {
      throw new Error("Failed to fetch storefront joiners")
    }
    const result = await response.json()
    return result.data || []
  },

  // Approve shop
  async approveShop(shopId: string) {
    try {
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.access_token) {
        throw new Error("No authentication token available")
      }

      const response = await fetch("/api/admin/shops/approve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ shopId }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || "Failed to approve shop")
      }

      return await response.json()
    } catch (error: any) {
      console.error("Error approving shop:", error)
      throw error
    }
  },

  // Reject/Deactivate shop
  async rejectShop(shopId: string) {
    try {
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.access_token) {
        throw new Error("No authentication token available")
      }

      const response = await fetch("/api/admin/shops/reject", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ shopId }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || "Failed to reject shop")
      }

      return await response.json()
    } catch (error: any) {
      console.error("Error rejecting shop:", error)
      throw error
    }
  },

  // Get shop details with orders
  async getShopDetails(shopId: string) {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const headers: HeadersInit = {}
      if (session?.access_token) {
        headers["Authorization"] = `Bearer ${session.access_token}`
      }
      const response = await fetch(`/api/admin/shops/${shopId}`, { headers })
      if (!response.ok) {
        throw new Error("Failed to fetch shop details")
      }
      const result = await response.json()
      return result.data || { shop: null, orders: [], profits: [] }
    } catch (error: any) {
      console.error("Error fetching shop details:", error)
      throw error
    }
  },

  // Block or unblock a shop temporarily
  async blockShop(shopId: string, reason: string) {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error("No authentication token available")

      const response = await fetch("/api/admin/shops/block", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ shopId, action: "block", reason }),
      })

      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to block shop")
      return data
    } catch (error: any) {
      console.error("Error blocking shop:", error)
      throw error
    }
  },

  async unblockShop(shopId: string) {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error("No authentication token available")

      const response = await fetch("/api/admin/shops/block", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ shopId, action: "unblock" }),
      })

      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to unblock shop")
      return data
    } catch (error: any) {
      console.error("Error unblocking shop:", error)
      throw error
    }
  },

  // Manual Balance Adjustment (Credit/Debit)
  async manualBalanceAdjustment(shopId: string, amount: number, type: "credit" | "debit", notes: string) {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error("No authentication token available")

      const response = await fetch(`/api/admin/shops/${shopId}/balance-adjustment`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ amount, type, notes }),
      })

      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to adjust balance")
      return data
    } catch (error: any) {
      console.error("Error adjusting shop balance:", error)
      throw error
    }
  },
}

// Admin Dashboard Stats
export const adminDashboardService = {
  // Get dashboard statistics. `range` scopes the newer hub fields
  // (rangeRevenue/rangeProfit/chartSeries/etc) to "today" | "7d" | "30d" --
  // the all-time fields (totalOrders, totalRevenue, ...) are unaffected.
  async getDashboardStats(range?: "today" | "7d" | "30d") {
    try {
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.access_token) {
        throw new Error("No authentication token available")
      }

      const url = range ? `/api/admin/dashboard-stats?range=${range}` : "/api/admin/dashboard-stats"
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })

      if (!response.ok) {
        throw new Error("Failed to fetch dashboard stats")
      }

      return await response.json()
    } catch (error) {
      console.error("Error fetching dashboard stats:", error)
      throw error
    }
  },

  // Breakdown panels (Revenue by Network, By Product, By Source, Top
  // Packages, Top Agents). `range` scopes those to "today" | "7d" | "30d",
  // matching the hub's toggle. Growth & Roles is always a live snapshot,
  // unaffected by `range`.
  async getDashboardAnalytics(range?: "today" | "7d" | "30d") {
    try {
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.access_token) {
        throw new Error("No authentication token available")
      }

      const url = range ? `/api/admin/dashboard-analytics?range=${range}` : "/api/admin/dashboard-analytics"
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })

      if (!response.ok) {
        throw new Error("Failed to fetch dashboard analytics")
      }

      return await response.json()
    } catch (error) {
      console.error("Error fetching dashboard analytics:", error)
      throw error
    }
  },
}

// Admin Order Management
export const adminOrderService = {
  // Get all pending orders
  async getPendingOrders() {
    const { data, error } = await supabase
      .from("shop_orders")
      .select("*")
      .eq("order_status", "pending")
      .order("created_at", { ascending: false })

    if (error) throw error
    return data
  },

  // Get orders by status
  async getOrdersByStatus(status: string) {
    const { data, error } = await supabase
      .from("shop_orders")
      .select("*")
      .eq("order_status", status)
      .order("created_at", { ascending: false })

    if (error) throw error
    return data
  },

  // Download pending orders (returns CSV)
  async downloadPendingOrders(orderIds: string[]) {
    try {
      const response = await fetch("/api/admin/orders/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIds }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to download orders")
      }

      return data
    } catch (error: any) {
      console.error("Error downloading orders:", error)
      throw error
    }
  },

  // Get download batches
  async getDownloadBatches() {
    const { data, error } = await supabase
      .from("order_download_batches")
      .select("*")
      .order("created_at", { ascending: false })

    if (error) {
      console.warn("Could not fetch download batches:", error.message)
      return []
    }
    return data
  },

  // Get download batches by network
  async getDownloadBatchesByNetwork(network: string) {
    const { data, error } = await supabase
      .from("order_download_batches")
      .select("*")
      .eq("network", network)
      .order("created_at", { ascending: false })

    if (error) {
      console.warn("Could not fetch download batches:", error.message)
      return []
    }
    return data
  },

  // Update order status
  async updateOrderStatus(orderId: string, status: string) {
    const { data, error } = await supabase
      .from("shop_orders")
      .update({ order_status: status, updated_at: new Date().toISOString() })
      .eq("id", orderId)
      .select()

    if (error) throw error
    return data[0]
  },

  // Get order statistics
  async getOrderStats() {
    // Fetch all orders with pagination to avoid 1000 row limit
    let allOrders: any[] = []
    let offset = 0
    const batchSize = 1000
    let hasMore = true

    while (hasMore) {
      const { data, error } = await supabase
        .from("shop_orders")
        .select("order_status")
        .range(offset, offset + batchSize - 1)

      if (error) throw error

      if (data && data.length > 0) {
        allOrders = allOrders.concat(data)
        offset += batchSize
        hasMore = data.length === batchSize
      } else {
        hasMore = false
      }
    }

    const stats = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    }

    allOrders.forEach((order: any) => {
      if (order.order_status in stats) {
        stats[order.order_status as keyof typeof stats]++
      }
    })

    return stats
  },
}

// Admin Messaging Management
export const adminMessagingService = {
  async getBroadcastLogs() {
    // broadcast_logs.results is kept authoritative by the recompute_broadcast_results
    // SQL function on every drain (initial send, cron, and retry), so we read the
    // stored value directly instead of re-aggregating per-channel counts here.
    const { data, error } = await supabase
      .from("broadcast_logs")
      .select(`
        *,
        admin:users!admin_id(id, first_name, email)
      `)
      .order("created_at", { ascending: false })

    if (error) throw error
    return data
  },

  async getEmailLogs(limit = 100) {
    const { data, error } = await supabase
      .from("email_logs")
      .select(`
        *,
        user:users!user_id(id, first_name, phone_number)
      `)
      .order("created_at", { ascending: false })
      .limit(limit)

    if (error) throw error
    return data
  },

  async getSMSLogs(limit = 100) {
    const { data, error } = await supabase
      .from("sms_logs")
      .select(`
        *,
        user:users!user_id(id, first_name, email)
      `)
      .order("created_at", { ascending: false })
      .limit(limit)

    if (error) throw error
    return data
  },

  // Fetch ALL users for broadcast (via API to bypass RLS)
  async getBroadcastRecipients() {
    try {
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.access_token) {
        throw new Error("No authentication token available")
      }

      const response = await fetch("/api/admin/broadcast/recipients", {
        headers: {
          "Authorization": `Bearer ${session.access_token}`,
        },
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || "Failed to fetch broadcast recipients")
      }

      return await response.json()
    } catch (error: any) {
      console.error("Error fetching broadcast recipients:", error)
      throw error
    }
  }
}

// Admin Payment Management
export const adminPaymentService = {
  // Get all payment attempts with filtering and pagination
  async getPaymentAttempts(params: URLSearchParams) {
    try {
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.access_token) {
        throw new Error("No authentication token available")
      }

      const response = await fetch(`/api/admin/payment-attempts?${params.toString()}`, {
        headers: {
          "Authorization": `Bearer ${session.access_token}`,
        },
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to fetch payment attempts")
      }

      return data
    } catch (error: any) {
      console.error("Error fetching payment attempts:", error)
      throw error
    }
  },

  // Update payment attempt status (mark as completed, etc.)
  async updatePaymentAttemptStatus(updateData: { id?: string; reference?: string; status: string }) {
    try {
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.access_token) {
        throw new Error("No authentication token available")
      }

      const response = await fetch("/api/admin/payment-attempts", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(updateData),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to update payment attempt status")
      }

      return data
    } catch (error: any) {
      console.error("Error updating payment attempt status:", error)
      throw error
    }
  },
}
