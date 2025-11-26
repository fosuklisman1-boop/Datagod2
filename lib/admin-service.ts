import { supabase } from "./supabase"

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
      const response = await fetch("/api/admin/packages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      const response = await fetch("/api/admin/packages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      const response = await fetch("/api/admin/packages/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
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
      const response = await fetch("/api/admin/users")
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
    const { data, error } = await supabase.auth.admin.updateUserById(userId, {
      user_metadata: { role },
    })

    if (error) throw error
    return data
  },

  // Update user balance (credit/debit)
  async updateUserBalance(shopId: string, amount: number, type: "credit" | "debit") {
    if (type === "credit") {
      const { data, error } = await supabase
        .from("shop_profits")
        .insert([{
          shop_id: shopId,
          shop_order_id: null,
          profit_amount: amount,
          status: "pending",
        }])
        .select()

      if (error) throw error
      return data[0]
    } else {
      // For debit, update existing pending profits
      const { data: profits } = await supabase
        .from("shop_profits")
        .select("id, profit_amount")
        .eq("shop_id", shopId)
        .eq("status", "pending")
        .order("created_at", { ascending: true })

      let remainingDebit = amount
      const updates = []

      for (const profit of profits || []) {
        if (remainingDebit <= 0) break

        if (profit.profit_amount <= remainingDebit) {
          updates.push({
            id: profit.id,
            profit_amount: 0,
            status: "withdrawn",
          })
          remainingDebit -= profit.profit_amount
        } else {
          updates.push({
            id: profit.id,
            profit_amount: profit.profit_amount - remainingDebit,
          })
          remainingDebit = 0
        }
      }

      for (const update of updates) {
        await supabase
          .from("shop_profits")
          .update(update)
          .eq("id", update.id)
      }

      return { success: true, debited: amount - remainingDebit }
    }
  },

  // Remove user
  async removeUser(userId: string) {
    const { error } = await supabase.auth.admin.deleteUser(userId)
    if (error) throw error
    return { success: true }
  },

  // Get user details
  async getUserDetails(userId: string) {
    const { data: user, error: userError } = await supabase
      .from("auth.users")
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
}

// Admin Shop Management
export const adminShopService = {
  // Get all shops with approval status
  async getAllShops() {
    const { data, error } = await supabase
      .from("user_shops")
      .select(`
        *,
        user_id
      `)
      .order("created_at", { ascending: false })

    if (error) throw error
    return data
  },

  // Get pending shop approvals
  async getPendingShops() {
    const { data, error } = await supabase
      .from("user_shops")
      .select("*")
      .eq("is_active", false)
      .order("created_at", { ascending: false })

    if (error) throw error
    return data
  },

  // Approve shop
  async approveShop(shopId: string) {
    const { data, error } = await supabase
      .from("user_shops")
      .update({ is_active: true, updated_at: new Date().toISOString() })
      .eq("id", shopId)
      .select()

    if (error) throw error
    return data[0]
  },

  // Reject/Deactivate shop
  async rejectShop(shopId: string) {
    const { data, error } = await supabase
      .from("user_shops")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", shopId)
      .select()

    if (error) throw error
    return data[0]
  },

  // Get shop details with orders
  async getShopDetails(shopId: string) {
    const { data: shop, error: shopError } = await supabase
      .from("user_shops")
      .select("*")
      .eq("id", shopId)
      .single()

    if (shopError) throw shopError

    const { data: orders } = await supabase
      .from("shop_orders")
      .select("*")
      .eq("shop_id", shopId)

    const { data: profits } = await supabase
      .from("shop_profits")
      .select("*")
      .eq("shop_id", shopId)

    return {
      shop,
      orders: orders || [],
      profits: profits || [],
    }
  },
}

// Admin Dashboard Stats
export const adminDashboardService = {
  // Get dashboard statistics
  async getDashboardStats() {
    // Total users
    const { data: users } = await supabase
      .from("auth.users")
      .select("id")

    // Total shops
    const { data: shops } = await supabase
      .from("user_shops")
      .select("id")

    // Total orders
    const { data: orders } = await supabase
      .from("shop_orders")
      .select("id, total_price, order_status")

    // Total revenue (sum of all order totals)
    const totalRevenue = orders?.reduce((sum: number, order: any) => {
      return sum + (order.total_price || 0)
    }, 0) || 0

    // Pending shops
    const { data: pendingShops } = await supabase
      .from("user_shops")
      .select("id")
      .eq("is_active", false)

    // Completed orders
    const completedOrders = orders?.filter((o: any) => o.order_status === "completed") || []

    return {
      totalUsers: users?.length || 0,
      totalShops: shops?.length || 0,
      totalOrders: orders?.length || 0,
      totalRevenue: totalRevenue,
      pendingShops: pendingShops?.length || 0,
      completedOrders: completedOrders.length,
      successRate: orders?.length ? ((completedOrders.length / orders.length) * 100).toFixed(2) : 0,
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
