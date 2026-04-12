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
          dealer_price,
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
    try {
      const response = await fetch(`/api/shop/orders/${orderId}`, {
        cache: "no-store",
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error || `HTTP ${response.status}: Failed to fetch order`)
      }

      const data = await response.json()
      return { order: data.order, shopOwner: data.shopOwner || {} }
    } catch (error) {
      console.error("Error in getOrderById:", error)
      throw error
    }
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

    // 1. Get the shop owner's user_id and current wallet balance
    const { data: shopOwner } = await supabase
      .from("user_shops")
      .select("user_id")
      .eq("id", shopId)
      .single()

    const userId = shopOwner?.user_id
    let recoveryApplied = false
    let recoveredAmount = 0

    if (userId) {
      // 2. Check for negative wallet balance
      const { data: wallet } = await supabase
        .from("wallets")
        .select("balance")
        .eq("user_id", userId)
        .single()

      if (wallet && wallet.balance < 0) {
        // Calculate recovery: amount that can be paid back from this profit
        recoveredAmount = Math.min(profitAmount, Math.abs(wallet.balance))

        if (recoveredAmount > 0) {
          console.log(`[DEBT-RECOVERY] Auto-recovering GHS ${recoveredAmount} from profit for user ${userId}`)
          
          // Use our atomic credit RPC to pay back the debt
          // We use a unique reference to prevent double recovery for the same profit/order
          const { data: recoveryResult, error: recoveryError } = await supabase.rpc("credit_wallet_safely", {
            p_user_id: userId,
            p_amount: recoveredAmount,
            p_reference_id: `RECOVERY_FOR_ORDER_${shopOrderId}`,
            p_description: "Automatic recovery from shop profit",
            p_source: "debt_recovery"
          })

          if (recoveryError) {
            console.error("[DEBT-RECOVERY] Error during auto-recovery:", recoveryError)
          } else {
            recoveryApplied = true
          }
        }
      }
    }

    // 3. Create the profit record
    // If we recovered the full amount, the status should be 'credited' (since it was immediately used)
    // If not, we still track it for the shop available balance.
    const { data, error } = await supabase
      .from("shop_profits")
      .insert([{
        shop_id: shopId,
        shop_order_id: shopOrderId,
        profit_amount: profitAmount,
        profit_balance_before: balanceBefore,
        profit_balance_after: balanceAfter,
        status: recoveryApplied ? "credited" : "pending",
        description: recoveryApplied ? `Debt recovery of GHS ${recoveredAmount.toFixed(2)} applied.` : null
      }])
      .select()

    if (error) throw error

    // Automatically sync balance after creating profit to ensure consistency
    // This prevents discrepancies between shop_profits and shop_available_balance tables
    await this.syncAvailableBalance(shopId)

    return data[0]
  },

  // Helper to fetch all records with pagination (avoids 1000 row limit)
  async fetchAllProfits(shopId: string, selectFields: string = "profit_amount, status") {
    let allRecords: any[] = []
    let offset = 0
    const batchSize = 1000
    let hasMore = true

    while (hasMore) {
      const { data, error } = await supabase
        .from("shop_profits")
        .select(selectFields)
        .eq("shop_id", shopId)
        .range(offset, offset + batchSize - 1)

      if (error) throw error

      if (data && data.length > 0) {
        allRecords = allRecords.concat(data)
        offset += batchSize
        hasMore = data.length === batchSize
      } else {
        hasMore = false
      }
    }

    return allRecords
  },

  // Get shop available balance - OPTIMIZED
  async getShopBalance(shopId: string) {
    try {
      const { data: breakdown, error } = await supabase.rpc("get_shop_balance_breakdown", {
        p_shop_id: shopId
      })

      if (error || !breakdown) return 0
      return Number(breakdown.credited_p) - Number(breakdown.total_w)
    } catch (err) {
      console.error("Error in getShopBalance:", err)
      return 0
    }
  },

  // Get total profit - OPTIMIZED
  async getTotalProfit(shopId: string) {
    try {
      const { data: breakdown, error } = await supabase.rpc("get_shop_balance_breakdown", {
        p_shop_id: shopId
      })

      if (error || !breakdown) return 0
      return Number(breakdown.total_p)
    } catch (err) {
      console.error("Error in getTotalProfit:", err)
      return 0
    }
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

  // Sync available balance to shop_available_balance table - OPTIMIZED
  async syncAvailableBalance(shopId: string) {
    try {
      // Get aggregated breakdown from SQL RPC (Avoids fetching thousands of rows into JS)
      const { data: breakdown, error: rpcError } = await supabase.rpc("get_shop_balance_breakdown", {
        p_shop_id: shopId
      })

      if (rpcError || !breakdown) {
        console.error("RPC Error in syncAvailableBalance:", rpcError)
        return
      }

      // Available balance = credited profit - approved/completed withdrawals
      const availableBalance = Number(breakdown.credited_p) - Number(breakdown.total_w)

      const { error: upsertError } = await supabase
        .from("shop_available_balance")
        .upsert(
          {
            shop_id: shopId,
            available_balance: availableBalance,
            total_profit: breakdown.total_p,
            withdrawn_amount: breakdown.total_w,
            credited_profit: breakdown.credited_p,
            withdrawn_profit: breakdown.withdrawn_p,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "shop_id" }
        )

      if (upsertError) {
        console.error("Error syncing available balance:", upsertError)
      }
    } catch (error) {
      console.error("Critical error in syncAvailableBalance:", error)
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

    // Block new withdrawals if any are pending OR approved (in-flight)
    try {
      const { data: inflightRequests, error: pendingError } = await supabase
        .from("withdrawal_requests")
        .select("id, amount, status")
        .eq("shop_id", shopId)
        .in("status", ["pending", "approved"])

      if (!pendingError && inflightRequests && inflightRequests.length > 0) {
        const pending  = inflightRequests.filter(w => w.status === "pending")
        const approved = inflightRequests.filter(w => w.status === "approved")
        if (approved.length > 0) {
          const total = approved.reduce((s, w) => s + (w.amount || 0), 0)
          throw new Error(`You have an approved withdrawal of GHS ${total.toFixed(2)} that has not been completed yet. Please wait for it to be marked as completed before requesting another.`)
        }
        if (pending.length > 0) {
          const total = pending.reduce((s, w) => s + (w.amount || 0), 0)
          throw new Error(`You already have a pending withdrawal request for GHS ${total.toFixed(2)}. Please wait for it to be approved or rejected before requesting another.`)
        }
      }
    } catch (error) {
      if (error instanceof Error && (error.message.includes("pending withdrawal") || error.message.includes("approved withdrawal"))) {
        throw error
      }
      console.warn(`[WITHDRAWAL-CREATE] Warning checking pending requests:`, error)
    }

    // Check current available balance before creating withdrawal
    try {
      // Use optimized RPC for balance check to avoid heavy loops
      const { data: balanceData, error: balanceError } = await supabase.rpc("get_shop_balance_breakdown", { p_shop_id: shopId })
      
      if (balanceError) throw balanceError

      // Use the pre-aggregated credited_profit and withdrawn_profit from the RPC
      const creditedProfit = balanceData?.credited_profit || 0
      const totalWithdrawn = balanceData?.withdrawn_profit || 0
      
      // Current available balance
      const currentAvailableBalance = creditedProfit - totalWithdrawn

      // Check if requested withdrawal amount exceeds available balance
      if (withdrawalData.amount > currentAvailableBalance) {
        throw new Error(`Insufficient balance. Available: GHS ${currentAvailableBalance.toFixed(2)}, Requested: GHS ${withdrawalData.amount.toFixed(2)}`)
      }

      // Store balance_before for history tracking
      ;(withdrawalData as any)._balanceBefore = currentAvailableBalance
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

    const balanceBefore = (withdrawalData as any)._balanceBefore
    const { _balanceBefore, ...cleanWithdrawalData } = withdrawalData as any

    const { data, error } = await supabase
      .from("withdrawal_requests")
      .insert([{
        user_id: userId,
        shop_id: shopId,
        ...cleanWithdrawalData,
        status: "pending",
        reference_code: `WD-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`,
        fee_amount: feeAmount,
        net_amount: netAmount,
        balance_before: balanceBefore ?? null,
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
