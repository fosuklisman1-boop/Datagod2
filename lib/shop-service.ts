import { supabase } from "./supabase"
import { getPriceAdjustments, getAdjustmentForNetwork, applyPriceAdjustment } from "./price-adjustment-service"

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
      .insert([{ user_id: userId, ...shopData, is_active: false }])
      .select()

    if (error) {
      console.error("Shop creation error:", error)
      if (error.message?.includes("relation")) {
        throw new Error("Database tables not yet set up. Please run the SQL schema in Supabase first.")
      }
      throw error
    }
    
    if (!data || data.length === 0) {
      throw new Error("Failed to create shop: no data returned")
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
          description,
          is_available
        )
      `)
      .eq("shop_id", shopData.id)
      .eq("is_available", true)
      .order("created_at", { ascending: false })

    if (error) throw error
    
    // Filter out packages that are disabled by admin (packages.is_available = false)
    const availableData = data?.filter(item => item.packages?.is_available !== false) || []
    
    // Apply price adjustments to the base package prices
    const priceAdjustments = await getPriceAdjustments()
    
    const adjustedData = availableData.map(item => {
      if (item.packages) {
        const adjustmentPercentage = getAdjustmentForNetwork(item.packages.network, priceAdjustments)
        const adjustedBasePrice = applyPriceAdjustment(item.packages.price, adjustmentPercentage)
        return {
          ...item,
          packages: {
            ...item.packages,
            price: adjustedBasePrice
          }
        }
      }
      return item
    })
    
    return adjustedData
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
    shop_customer_id?: string
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
      .eq("payment_status", "completed")

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
    // Get current balance before adding this profit
    const currentBalance = await this.getShopBalance(shopId)
    const balanceBefore = currentBalance
    const balanceAfter = currentBalance + profitAmount

    const { data, error } = await supabase
      .from("shop_profits")
      .insert([{
        shop_id: shopId,
        shop_order_id: shopOrderId,
        profit_amount: profitAmount,
        profit_balance_before: balanceBefore,
        profit_balance_after: balanceAfter,
        status: "pending"
      }])
      .select()

    if (error) throw error
    return data[0]
  },

  // Get shop available balance
  async getShopBalance(shopId: string) {
    // Get pending and credited profits from shop_profits table
    const { data: profits, error: profitError } = await supabase
      .from("shop_profits")
      .select("profit_amount, status")
      .eq("shop_id", shopId)

    if (profitError) throw profitError
    
    // Sum all pending profits (not yet withdrawn)
    const availableBalance = profits?.reduce((sum, p) => {
      if (p.status === "pending" || p.status === "credited") {
        return sum + (p.profit_amount || 0)
      }
      return sum
    }, 0) || 0
    
    return Math.max(0, availableBalance)
  },

  // Get total profit (sum of all profit_amount from completed orders)
  async getTotalProfit(shopId: string) {
    const { data, error } = await supabase
      .from("shop_orders")
      .select("profit_amount")
      .eq("shop_id", shopId)
      .eq("payment_status", "completed")

    if (error) throw error
    
    // Sum all profit amounts
    const totalProfit = data?.reduce((sum, order) => sum + (order.profit_amount || 0), 0) || 0
    return totalProfit
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

  // Sync available balance to shop_available_balance table
  async syncAvailableBalance(shopId: string) {
    try {
      // Get current profits breakdown
      const { data: profits, error: profitError } = await supabase
        .from("shop_profits")
        .select("profit_amount, status")
        .eq("shop_id", shopId)

      if (profitError) throw profitError

      // Calculate credited profit only
      const breakdown = {
        totalProfit: 0,
        creditedProfit: 0,
        withdrawnProfit: 0,
      }

      profits?.forEach((p: any) => {
        const amount = p.profit_amount || 0
        breakdown.totalProfit += amount
        if (p.status === "credited") {
          breakdown.creditedProfit += amount
        } else if (p.status === "withdrawn") {
          breakdown.withdrawnProfit += amount
        }
      })

      // Get approved withdrawals to subtract from available balance
      const { data: approvedWithdrawals, error: withdrawalError } = await supabase
        .from("withdrawal_requests")
        .select("amount")
        .eq("shop_id", shopId)
        .eq("status", "approved")

      let totalApprovedWithdrawals = 0
      if (!withdrawalError && approvedWithdrawals) {
        totalApprovedWithdrawals = approvedWithdrawals.reduce((sum, w) => sum + (w.amount || 0), 0)
      }

      // Available balance = credited profit - approved withdrawals
      const availableBalance = Math.max(0, breakdown.creditedProfit - totalApprovedWithdrawals)

      // Delete existing record and insert fresh (more reliable than upsert)
      const deleteResult = await supabase
        .from("shop_available_balance")
        .delete()
        .eq("shop_id", shopId)

      if (deleteResult.error) {
        console.warn("Warning deleting old balance:", deleteResult.error)
      }

      const { error: insertError } = await supabase
        .from("shop_available_balance")
        .insert([
          {
            shop_id: shopId,
            available_balance: availableBalance,
            total_profit: breakdown.totalProfit,
            withdrawn_amount: breakdown.withdrawnProfit,
            credited_profit: breakdown.creditedProfit,
            withdrawn_profit: breakdown.withdrawnProfit,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }
        ])

      if (insertError) {
        console.error("Error syncing available balance:", insertError)
        // Don't throw - this is just a sync, shouldn't block main operations
      }
    } catch (error) {
      console.error("Error in syncAvailableBalance:", error)
    }
  },

  // Get shop available balance from table (faster query)
  async getShopBalanceFromTable(shopId: string) {
    try {
      const { data, error } = await supabase
        .from("shop_available_balance")
        .select("available_balance, pending_profit, credited_profit, withdrawn_profit, total_profit")
        .eq("shop_id", shopId)

      // Return null if table doesn't exist or no data found
      if (error) {
        console.warn("shop_available_balance table query error:", error.code)
        return null
      }

      // Return first record if exists, otherwise null
      return data && data.length > 0 ? data[0] : null
    } catch (error) {
      console.error("Error fetching balance from table:", error)
      return null
    }
  },
}

// Withdrawal operations
export const withdrawalService = {
  // Create withdrawal request and sync balance
  async createWithdrawalRequest(userId: string, shopId: string, withdrawalData: {
    amount: number
    withdrawal_method: string
    account_details: any
  }) {
    // Validate withdrawal amount is positive
    if (!withdrawalData.amount || withdrawalData.amount <= 0) {
      throw new Error("Invalid withdrawal amount")
    }

    // Validate minimum withdrawal amount
    if (withdrawalData.amount < 5) {
      throw new Error("Minimum withdrawal amount is GHS 5.00")
    }

    // Check if there's already a pending withdrawal request
    try {
      const { data: pendingRequests, error: pendingError } = await supabase
        .from("withdrawal_requests")
        .select("id, amount")
        .eq("shop_id", shopId)
        .eq("status", "pending")

      if (!pendingError && pendingRequests && pendingRequests.length > 0) {
        const totalPending = pendingRequests.reduce((sum, w) => sum + (w.amount || 0), 0)
        throw new Error(`You already have a pending withdrawal request for GHS ${totalPending.toFixed(2)}. Please wait for it to be approved or rejected before requesting another.`)
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("pending withdrawal")) {
        throw error
      }
      console.warn(`[WITHDRAWAL-CREATE] Warning checking pending requests:`, error)
    }

    // Check current available balance before creating withdrawal
    try {
      const { data: profits, error: profitError } = await supabase
        .from("shop_profits")
        .select("profit_amount, status")
        .eq("shop_id", shopId)

      if (profitError) throw profitError

      // Calculate credited profit only
      const breakdown = {
        creditedProfit: 0,
      }

      profits?.forEach((p: any) => {
        const amount = p.profit_amount || 0
        if (p.status === "credited") {
          breakdown.creditedProfit += amount
        }
      })

      // Get approved withdrawals to calculate current available balance
      const { data: approvedWithdrawals, error: withdrawalError } = await supabase
        .from("withdrawal_requests")
        .select("amount")
        .eq("shop_id", shopId)
        .eq("status", "approved")

      let totalApprovedWithdrawals = 0
      if (!withdrawalError && approvedWithdrawals) {
        totalApprovedWithdrawals = approvedWithdrawals.reduce((sum, w) => sum + (w.amount || 0), 0)
      }

      // Current available balance = credited profit - approved withdrawals
      const currentAvailableBalance = Math.max(0, breakdown.creditedProfit - totalApprovedWithdrawals)

      // Check if requested withdrawal amount exceeds available balance
      if (withdrawalData.amount > currentAvailableBalance) {
        throw new Error(`Insufficient balance. Available: GHS ${currentAvailableBalance.toFixed(2)}, Requested: GHS ${withdrawalData.amount.toFixed(2)}`)
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("Insufficient balance")) {
        throw error
      }
      // Log other errors but allow withdrawal creation if balance check fails
      console.warn(`[WITHDRAWAL-CREATE] Warning checking balance:`, error)
    }

    // Fetch withdrawal fee percentage from settings
    let withdrawalFeePercentage = 0
    try {
      const { data: settings, error: settingsError } = await supabase
        .from("app_settings")
        .select("withdrawal_fee_percentage")
        .single()

      if (!settingsError && settings?.withdrawal_fee_percentage) {
        withdrawalFeePercentage = settings.withdrawal_fee_percentage / 100
      }
    } catch (settingsError) {
      console.warn(`[WITHDRAWAL-CREATE] Warning fetching fee settings:`, settingsError)
      // Continue with default 0 fee if settings fetch fails
    }

    // Calculate fee and net amount
    const feeAmount = Math.round(withdrawalData.amount * withdrawalFeePercentage * 100) / 100
    const netAmount = withdrawalData.amount - feeAmount

    console.log(`[WITHDRAWAL-CREATE] Fee Calculation:`)
    console.log(`  Requested Amount: GHS ${withdrawalData.amount}`)
    console.log(`  Withdrawal Fee (${withdrawalFeePercentage * 100}%): GHS ${feeAmount}`)
    console.log(`  Net Amount (Shop Receives): GHS ${netAmount}`)

    const { data, error } = await supabase
      .from("withdrawal_requests")
      .insert([{
        user_id: userId,
        shop_id: shopId,
        ...withdrawalData,
        status: "pending",
        reference_code: `WD-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`,
        fee_amount: feeAmount,
        net_amount: netAmount
      }])
      .select()

    if (error) throw error
    
    // Sync available balance after creating withdrawal request
    // This reduces available balance by the withdrawal amount
    try {
      await shopProfitService.syncAvailableBalance(shopId)
      console.log(`[WITHDRAWAL-CREATE] Balance synced for shop ${shopId} after withdrawal request of GHS ${withdrawalData.amount}`)
    } catch (syncError) {
      console.warn(`[WITHDRAWAL-CREATE] Warning syncing balance:`, syncError)
      // Don't throw - withdrawal was created successfully
    }
    
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
    
    // If withdrawal is completed, mark profits as withdrawn
    if (status === "completed" && data[0]) {
      const withdrawal = data[0]
      
      // Get pending profits for this shop and mark them as withdrawn
      // Order by created_at to mark oldest profits first
      const { data: profits, error: profitFetchError } = await supabase
        .from("shop_profits")
        .select("id, profit_amount")
        .eq("shop_id", withdrawal.shop_id)
        .in("status", ["pending", "credited"])
        .order("created_at", { ascending: true })

      if (!profitFetchError && profits) {
        let remainingAmount = withdrawal.amount
        const profitsToUpdate = []

        for (const profit of profits) {
          if (remainingAmount <= 0) break
          
          if (profit.profit_amount <= remainingAmount) {
            profitsToUpdate.push(profit.id)
            remainingAmount -= profit.profit_amount
          } else {
            break
          }
        }

        // Mark matched profits as withdrawn
        if (profitsToUpdate.length > 0) {
          const updatePayload: any = {
            status: "withdrawn"
          }
          
          // Only update withdrawn_at if the column exists
          try {
            await supabase
              .from("shop_profits")
              .update({
                ...updatePayload,
                withdrawn_at: new Date().toISOString()
              })
              .in("id", profitsToUpdate)
          } catch (error) {
            // If withdrawn_at column doesn't exist, just update status
            console.warn("Could not update withdrawn_at, updating status only:", error)
            await supabase
              .from("shop_profits")
              .update(updatePayload)
              .in("id", profitsToUpdate)
          }
          
          // Sync available balance after marking profits as withdrawn
          await shopProfitService.syncAvailableBalance(withdrawal.shop_id)
        }
      }
    }
    
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
