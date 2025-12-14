import { supabase } from "./supabase"
import { refreshUserSession } from "./session-refresh"

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
}

// Admin User Management
export const adminUserService = {
  // Get all users with their shop and balance info
  async getAllUsers() {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      
      if (!session?.access_token) {
        throw new Error("No authentication token available")
      }

      const response = await fetch("/api/admin/users", {
        headers: {
          "Authorization": `Bearer ${session.access_token}`,
        },
      })
      if (!response.ok) {
        throw new Error("Failed to fetch users")
      }
      const users = await response.json()
      return users
    } catch (error: any) {
      console.error("Error in getAllUsers:", error)
      throw error
    }
  },

  // Update user role
  async updateUserRole(userId: string, role: string) {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      
      if (!session?.access_token) {
        throw new Error("No authentication token available")
      }

      const endpoint = role === "admin" ? "/api/admin/set-admin" : "/api/admin/remove-admin"
      
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ userId }),
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

  // Update user balance (credit/debit)
  async updateUserBalance(shopId: string, amount: number, type: "credit" | "debit") {
    try {
      // Get the user_id from the shop
      const { data: shop, error: shopError } = await supabase
        .from("user_shops")
        .select("user_id")
        .eq("id", shopId)
        .single()

      if (shopError || !shop) {
        throw new Error("Shop not found")
      }

      const userId = shop.user_id

      // Get current wallet balance
      const { data: wallet, error: walletError } = await supabase
        .from("wallets")
        .select("balance")
        .eq("user_id", userId)
        .single()

      if (walletError || !wallet) {
        throw new Error("Wallet not found for user")
      }

      const currentBalance = wallet.balance || 0
      const newBalance = type === "credit" 
        ? currentBalance + amount 
        : Math.max(0, currentBalance - amount)

      // Update wallet balance
      const { data: updated, error: updateError } = await supabase
        .from("wallets")
        .update({ balance: newBalance })
        .eq("user_id", userId)
        .select()

      if (updateError) {
        throw new Error(`Failed to update wallet: ${updateError.message}`)
      }

      return updated[0]
    } catch (error) {
      console.error("Error in updateUserBalance:", error)
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
  async changeUserPassword(
    userId: string,
    newPassword: string,
    session: any
  ) {
    const response = await fetch("/api/admin/change-user-password", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        userId,
        newPassword,
      }),
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || "Failed to change user password")
    }

    return await response.json()
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

      const response = await fetch("/api/admin/shops", { headers })
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
      const response = await fetch(`/api/admin/shops/${shopId}`)
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
}

// Admin Dashboard Stats
export const adminDashboardService = {
  // Get dashboard statistics
  async getDashboardStats() {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      
      if (!session?.access_token) {
        throw new Error("No authentication token available")
      }

      const response = await fetch("/api/admin/dashboard-stats", {
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
    const { data, error } = await supabase
      .from("shop_orders")
      .select("order_status")

    if (error) throw error

    const stats = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    }

    data?.forEach((order: any) => {
      if (order.order_status in stats) {
        stats[order.order_status as keyof typeof stats]++
      }
    })

    return stats
  },
}
