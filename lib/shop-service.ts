import { supabase } from "./supabase"

// Shop operations
export const shopService = {
  // Create a shop for user
  async createShop(userId: string, shopData: {
    shop_name: string
    shop_slug: string
    description?: string
    logo_url?: string
    banner_url?: string
  }) {
    const { data, error } = await supabase
      .from("user_shops")
      .insert([{ user_id: userId, ...shopData, is_active: true }])
      .select()

    if (error) {
      console.error("Shop creation error:", error)
      if (error.message?.includes("relation")) {
        throw new Error("Database tables not yet set up. Please run the SQL schema in Supabase first.")
      }
      throw error
    }
    return data[0]
  },

  // Get user's shop
  async getShop(userId: string) {
    const { data, error } = await supabase
      .from("user_shops")
      .select("*")
      .eq("user_id", userId)
      .single()

    if (error && error.code !== "PGRST116") throw error
    return data
  },

  // Get shop by slug (public)
  async getShopBySlug(slug: string) {
    const { data, error } = await supabase
      .from("user_shops")
      .select("*")
      .eq("shop_slug", slug)
      .eq("is_active", true)
      .single()

    if (error && error.code !== "PGRST116") throw error
    return data
  },

  // Update shop
  async updateShop(shopId: string, updates: any) {
    const { data, error } = await supabase
      .from("user_shops")
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq("id", shopId)
      .select()

    if (error) throw error
    return data[0]
  },
}

// Shop Packages operations
export const shopPackageService = {
  // Add package to shop with profit margin
  async addPackageToShop(shopId: string, packageId: string, profitMargin: number, customName?: string) {
    const { data, error } = await supabase
      .from("shop_packages")
      .insert([{
        shop_id: shopId,
        package_id: packageId,
        profit_margin: profitMargin,
        custom_name: customName,
        is_available: true
      }])
      .select()

    if (error) throw error
    return data[0]
  },

  // Get shop packages
  async getShopPackages(shopId: string) {
    const { data, error } = await supabase
      .from("shop_packages")
      .select(`
        *,
        packages (
          id,
          network,
          size,
          price,
          description
        )
      `)
      .eq("shop_id", shopId)
      .order("created_at", { ascending: false })

    if (error) throw error
    return data
  },

  // Get available packages for public storefront
  async getAvailableShopPackages(shopSlug: string) {
    // First get the shop by slug
    const { data: shopData, error: shopError } = await supabase
      .from("user_shops")
      .select("id")
      .eq("shop_slug", shopSlug)
      .eq("is_active", true)
      .single()

    if (shopError || !shopData) {
      throw new Error("Shop not found")
    }

    // Now get the packages for this shop
    const { data, error } = await supabase
      .from("shop_packages")
      .select(`
        *,
        packages (
          id,
          network,
          size,
          price,
          description
        )
      `)
      .eq("shop_id", shopData.id)
      .eq("is_available", true)
      .order("created_at", { ascending: false })

    if (error) throw error
    return data
  },

  // Update package profit margin
  async updatePackageProfitMargin(shopPackageId: string, profitMargin: number) {
    const { data, error } = await supabase
      .from("shop_packages")
      .update({ profit_margin: profitMargin, updated_at: new Date().toISOString() })
      .eq("id", shopPackageId)
      .select()

    if (error) throw error
    return data[0]
  },

  // Toggle package availability
  async togglePackageAvailability(shopPackageId: string, isAvailable: boolean) {
    const { data, error } = await supabase
      .from("shop_packages")
      .update({ is_available: isAvailable, updated_at: new Date().toISOString() })
      .eq("id", shopPackageId)
      .select()

    if (error) throw error
    return data[0]
  },

  // Remove package from shop
  async removePackageFromShop(shopPackageId: string) {
    const { error } = await supabase
      .from("shop_packages")
      .delete()
      .eq("id", shopPackageId)

    if (error) throw error
  },
}

// Shop Orders operations
export const shopOrderService = {
  // Create shop order (customer purchase)
  async createShopOrder(orderData: {
    shop_id: string
    customer_email: string
    customer_phone: string
    customer_name?: string
    shop_package_id: string
    package_id: string
    network: string
    volume_gb: number
    base_price: number
    profit_amount: number
    total_price: number
  }) {
    const { data, error } = await supabase
      .from("shop_orders")
      .insert([{
        ...orderData,
        order_status: "pending",
        payment_status: "pending",
        reference_code: `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`
      }])
      .select()

    if (error) throw error
    return data[0]
  },

  // Get shop orders
  async getShopOrders(shopId: string, status?: string) {
    let query = supabase
      .from("shop_orders")
      .select("*")
      .eq("shop_id", shopId)

    if (status) {
      query = query.eq("order_status", status)
    }

    const { data, error } = await query.order("created_at", { ascending: false })

    if (error) throw error
    return data
  },

  // Get order by ID
  async getOrderById(orderId: string) {
    const { data, error } = await supabase
      .from("shop_orders")
      .select("*")
      .eq("id", orderId)
      .single()

    if (error) throw error
    return data
  },

  // Update order status
  async updateOrderStatus(orderId: string, orderStatus: string, paymentStatus?: string) {
    const updates: any = {
      order_status: orderStatus,
      updated_at: new Date().toISOString()
    }

    if (paymentStatus) {
      updates.payment_status = paymentStatus
    }

    const { data, error } = await supabase
      .from("shop_orders")
      .update(updates)
      .eq("id", orderId)
      .select()

    if (error) throw error
    return data[0]
  },

  // Get order statistics
  async getOrderStatistics(shopId: string) {
    const { data, error } = await supabase
      .from("shop_orders")
      .select("*")
      .eq("shop_id", shopId)

    if (error) throw error
    return data
  },
}

// Shop Profits operations
export const shopProfitService = {
  // Create profit record (called after order completion)
  async createProfitRecord(shopOrderId: string, shopId: string, profitAmount: number) {
    const { data, error } = await supabase
      .from("shop_profits")
      .insert([{
        shop_id: shopId,
        shop_order_id: shopOrderId,
        profit_amount: profitAmount,
        status: "pending"
      }])
      .select()

    if (error) throw error
    return data[0]
  },

  // Get shop available balance
  async getShopBalance(shopId: string) {
    const { data, error } = await supabase
      .rpc("get_shop_available_balance", { p_shop_id: shopId })

    if (error) throw error
    return data || 0
  },

  // Get total profit (pending + credited)
  async getTotalProfit(shopId: string) {
    const { data, error } = await supabase
      .rpc("get_shop_total_profit", { p_shop_id: shopId })

    if (error) throw error
    return data || 0
  },

  // Get profit history
  async getProfitHistory(shopId: string) {
    const { data, error } = await supabase
      .from("shop_profits")
      .select(`
        *,
        shop_orders (
          id,
          customer_name,
          customer_email,
          volume_gb,
          network,
          created_at
        )
      `)
      .eq("shop_id", shopId)
      .order("created_at", { ascending: false })

    if (error) throw error
    return data
  },

  // Credit profits to wallet
  async creditProfit(profitIds: string[]) {
    const { data, error } = await supabase
      .from("shop_profits")
      .update({
        status: "credited",
        credited_at: new Date().toISOString()
      })
      .in("id", profitIds)
      .select()

    if (error) throw error
    return data
  },
}

// Withdrawal operations
export const withdrawalService = {
  // Create withdrawal request
  async createWithdrawalRequest(userId: string, shopId: string, withdrawalData: {
    amount: number
    withdrawal_method: string
    account_details: any
  }) {
    const { data, error } = await supabase
      .from("withdrawal_requests")
      .insert([{
        user_id: userId,
        shop_id: shopId,
        ...withdrawalData,
        status: "pending",
        reference_code: `WD-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`
      }])
      .select()

    if (error) throw error
    return data[0]
  },

  // Get withdrawal requests
  async getWithdrawalRequests(userId: string) {
    const { data, error } = await supabase
      .from("withdrawal_requests")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })

    if (error) throw error
    return data
  },

  // Get withdrawal request by ID
  async getWithdrawalById(withdrawalId: string) {
    const { data, error } = await supabase
      .from("withdrawal_requests")
      .select("*")
      .eq("id", withdrawalId)
      .single()

    if (error) throw error
    return data
  },

  // Update withdrawal status
  async updateWithdrawalStatus(withdrawalId: string, status: string, updates?: any) {
    const updateData: any = {
      status,
      updated_at: new Date().toISOString(),
      ...updates
    }

    if (status === "completed") {
      updateData.completed_at = new Date().toISOString()
    }

    const { data, error } = await supabase
      .from("withdrawal_requests")
      .update(updateData)
      .eq("id", withdrawalId)
      .select()

    if (error) throw error
    return data[0]
  },

  // Get withdrawal statistics
  async getWithdrawalStatistics(shopId: string) {
    const { data, error } = await supabase
      .from("withdrawal_requests")
      .select("*")
      .eq("shop_id", shopId)

    if (error) throw error
    return data
  },
}

// Shop Settings operations
export const shopSettingsService = {
  // Get or create shop settings
  async getShopSettings(shopId: string) {
    const { data, error } = await supabase
      .from("shop_settings")
      .select("*")
      .eq("shop_id", shopId)
      .single()

    if (error && error.code !== "PGRST116") throw error
    return data
  },

  // Update shop settings
  async updateShopSettings(shopId: string, settings: any) {
    const { data, error } = await supabase
      .from("shop_settings")
      .upsert({
        shop_id: shopId,
        ...settings,
        updated_at: new Date().toISOString()
      }, { onConflict: "shop_id" })
      .select()

    if (error) throw error
    return data[0]
  },
}

// Network logo operations (using Supabase Storage bucket)
export const networkLogoService = {
  // Get all network logos
  async getAllNetworkLogos() {
    const { data, error } = await supabase
      .from("network_logos")
      .select("*")
      .order("network_name", { ascending: true })

    if (error) {
      console.error("Error fetching network logos:", error)
      return []
    }
    return data || []
  },

  // Get single network logo URL
  async getNetworkLogo(networkName: string) {
    const { data, error } = await supabase
      .from("network_logos")
      .select("logo_url")
      .eq("network_name", networkName)
      .single()

    if (error && error.code !== "PGRST116") {
      console.error(`Error fetching logo for ${networkName}:`, error)
    }
    return data?.logo_url || null
  },

  // Update network logo URL
  async updateNetworkLogo(networkName: string, logoUrl: string) {
    const { data, error } = await supabase
      .from("network_logos")
      .upsert({
        network_name: networkName,
        logo_url: logoUrl,
        updated_at: new Date().toISOString()
      }, { onConflict: "network_name" })
      .select()

    if (error) {
      console.error("Error updating network logo:", error)
      throw error
    }
    return data[0]
  },

  // Get all logos as object (for efficient caching)
  async getLogosAsObject() {
    const logos = await this.getAllNetworkLogos()
    const logosObj: Record<string, string> = {}
    
    logos.forEach(logo => {
      logosObj[logo.network_name] = logo.logo_url
    })
    
    return logosObj
  },

  // Upload logo image to bucket
  async uploadNetworkLogo(networkName: string, file: File) {
    try {
      const fileName = `${networkName.toLowerCase()}-${Date.now()}.${file.name.split('.').pop()}`
      
      const { error: uploadError } = await supabase.storage
        .from("network-logos")
        .upload(fileName, file, {
          upsert: true
        })

      if (uploadError) throw uploadError

      // Get public URL
      const { data } = supabase.storage
        .from("network-logos")
        .getPublicUrl(fileName)

      const logoUrl = data.publicUrl

      // Update database with new URL
      await this.updateNetworkLogo(networkName, logoUrl)

      return logoUrl
    } catch (error) {
      console.error("Error uploading network logo:", error)
      throw error
    }
  },

  // Get public URL for a logo file
  getPublicLogoUrl(fileName: string) {
    const { data } = supabase.storage
      .from("network-logos")
      .getPublicUrl(fileName)

    return data.publicUrl
  }
}
