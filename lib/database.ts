import { supabase } from "./supabase"

// User operations
export const userService = {
  async getUser(userId: string) {
    const { data, error } = await supabase
      .from("users")
      .select("*")
      .eq("id", userId)
      .single()

    if (error) throw error
    return data
  },

  async createUser(userData: any) {
    const { data, error } = await supabase
      .from("users")
      .insert([userData])
      .select()

    if (error) throw error
    return data[0]
  },

  async updateUser(userId: string, updates: any) {
    const { data, error } = await supabase
      .from("users")
      .update(updates)
      .eq("id", userId)
      .select()

    if (error) throw error
    return data[0]
  },
}

// Data packages operations
export const packageService = {
  async getPackages() {
    const { data, error } = await supabase
      .from("packages")
      .select("*")
      .order("created_at", { ascending: false })

    if (error) throw error
    return data
  },

  async getPackagesByNetwork(network: string) {
    const { data, error } = await supabase
      .from("packages")
      .select("*")
      .eq("network", network)
      .order("size", { ascending: true })

    if (error) throw error
    return data
  },

  async createPackage(packageData: any) {
    const { data, error } = await supabase
      .from("packages")
      .insert([packageData])
      .select()

    if (error) throw error
    return data[0]
  },
}

// Orders operations
export const orderService = {
  async getOrders(userId: string) {
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })

    if (error) throw error
    return data
  },

  async getOrderById(orderId: string) {
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("id", orderId)
      .single()

    if (error) throw error
    return data
  },

  async createOrder(orderData: any) {
    const { data, error } = await supabase
      .from("orders")
      .insert([orderData])
      .select()

    if (error) throw error
    return data[0]
  },

  async updateOrder(orderId: string, updates: any) {
    const { data, error } = await supabase
      .from("orders")
      .update(updates)
      .eq("id", orderId)
      .select()

    if (error) throw error
    return data[0]
  },
}

// Wallet operations
export const walletService = {
  async getWallet(userId: string) {
    const { data, error } = await supabase
      .from("wallets")
      .select("*")
      .eq("user_id", userId)
      .single()

    if (error && error.code !== "PGRST116") throw error
    return data
  },

  async createWallet(walletData: any) {
    const { data, error } = await supabase
      .from("wallets")
      .insert([walletData])
      .select()

    if (error) throw error
    return data[0]
  },

  async updateBalance(userId: string, amount: number) {
    const { data, error } = await supabase.rpc("update_wallet_balance", {
      p_user_id: userId,
      p_amount: amount,
    })

    if (error) throw error
    return data
  },
}

// Transactions operations
export const transactionService = {
  async getTransactions(userId: string) {
    const { data, error } = await supabase
      .from("transactions")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })

    if (error) throw error
    return data
  },

  async createTransaction(transactionData: any) {
    const { data, error } = await supabase
      .from("transactions")
      .insert([transactionData])
      .select()

    if (error) throw error
    return data[0]
  },
}

// AFA Orders operations
export const afaOrderService = {
  async getAFAOrders(userId: string) {
    const { data, error } = await supabase
      .from("afa_orders")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })

    if (error) throw error
    return data
  },

  async createAFAOrder(afaOrderData: any) {
    const { data, error } = await supabase
      .from("afa_orders")
      .insert([afaOrderData])
      .select()

    if (error) throw error
    return data[0]
  },

  async updateAFAOrder(afaOrderId: string, updates: any) {
    const { data, error } = await supabase
      .from("afa_orders")
      .update(updates)
      .eq("id", afaOrderId)
      .select()

    if (error) throw error
    return data[0]
  },
}

// Complaints operations
export const complaintService = {
  async getComplaints(userId: string) {
    const { data, error } = await supabase
      .from("complaints")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })

    if (error) throw error
    return data
  },

  async getAllComplaints() {
    const { data, error } = await supabase
      .from("complaints")
      .select(`
        *,
        user:user_id (
          id,
          email
        )
      `)
      .order("created_at", { ascending: false })

    if (error) throw error
    return data
  },

  async createComplaint(complaintData: any) {
    const { data, error } = await supabase
      .from("complaints")
      .insert([complaintData])
      .select()

    if (error) throw error
    return data[0]
  },

  async updateComplaint(complaintId: string, updates: any) {
    console.log(`[Database] Updating complaint ${complaintId} with:`, updates)
    
    const { data, error } = await supabase
      .from("complaints")
      .update(updates)
      .eq("id", complaintId)
      .select()

    if (error) {
      console.error(`[Database] Error updating complaint:`, error)
      throw error
    }
    
    console.log(`[Database] Update successful, returned:`, data)
    return data[0]
  },
}
