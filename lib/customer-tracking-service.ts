import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

interface CustomerTrackingInput {
  shopId: string
  phoneNumber: string
  email: string
  customerName: string
  totalPrice: number
  slug?: string
  orderId?: string
}

interface CustomerStats {
  total_customers: number
  repeat_customers: number
  repeat_percentage: number
  new_customers_month: number
  average_ltv: number
  total_revenue: number
}

export const customerTrackingService = {
  /**
   * Track or update a customer on purchase
   * Creates new customer if not exists, updates existing if repeat purchase
   */
  async trackCustomer(input: CustomerTrackingInput) {
    try {
      const { shopId, phoneNumber, email, customerName, totalPrice, slug } = input

      console.log(`[CUSTOMER-TRACKING] Tracking customer: ${phoneNumber} for shop ${shopId}`)

      // Check if customer already exists
      const { data: existingCustomer, error: fetchError } = await supabase
        .from("shop_customers")
        .select("id, total_purchases, total_spent, repeat_customer")
        .eq("shop_id", shopId)
        .eq("phone_number", phoneNumber)
        .single()

      if (fetchError && fetchError.code !== "PGRST116") {
        // PGRST116 = not found (expected for new customers)
        throw fetchError
      }

      let customerId: string

      if (existingCustomer) {
        // UPDATE existing customer (repeat purchase)
        const newTotalSpent = (existingCustomer.total_spent || 0) + totalPrice
        const newPurchases = (existingCustomer.total_purchases || 0) + 1

        console.log(
          `[CUSTOMER-TRACKING] Repeat customer: ${phoneNumber} - Purchase #${newPurchases}`
        )

        const { data: updated, error: updateError } = await supabase
          .from("shop_customers")
          .update({
            last_purchase_at: new Date().toISOString(),
            total_purchases: newPurchases,
            total_spent: newTotalSpent,
            repeat_customer: newPurchases > 1,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existingCustomer.id)
          .select("id")
          .single()

        if (updateError) throw updateError

        customerId = existingCustomer.id
      } else {
        // CREATE new customer
        console.log(`[CUSTOMER-TRACKING] New customer: ${phoneNumber}`)

        const { data: newCustomer, error: insertError } = await supabase
          .from("shop_customers")
          .insert([
            {
              shop_id: shopId,
              phone_number: phoneNumber,
              email: email,
              customer_name: customerName,
              first_purchase_at: new Date().toISOString(),
              last_purchase_at: new Date().toISOString(),
              total_purchases: 1,
              total_spent: totalPrice,
              repeat_customer: false,
              first_source_slug: slug || "unknown",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ])
          .select("id")
          .single()

        if (insertError) throw insertError

        customerId = newCustomer.id
      }

      return {
        success: true,
        customerId,
        isRepeatCustomer: !!existingCustomer,
      }
    } catch (error) {
      console.error("[CUSTOMER-TRACKING] Error tracking customer:", error)
      throw error
    }
  },

  /**
   * Create tracking record for an order
   */
  async createTrackingRecord(
    shopId: string,
    orderId: string,
    customerId: string,
    slug?: string
  ) {
    try {
      console.log(
        `[CUSTOMER-TRACKING] Creating tracking record for order ${orderId}`
      )

      const { error } = await supabase.from("customer_tracking").insert([
        {
          shop_order_id: orderId,
          shop_customer_id: customerId,
          shop_id: shopId,
          accessed_via_slug: slug || "unknown",
          accessed_at: new Date().toISOString(),
          purchase_completed: true,
          created_at: new Date().toISOString(),
        },
      ])

      if (error) throw error

      console.log(`[CUSTOMER-TRACKING] ✓ Tracking record created`)
      return { success: true }
    } catch (error) {
      console.error("[CUSTOMER-TRACKING] Error creating tracking record:", error)
      throw error
    }
  },

  /**
   * Get customer statistics for a shop
   */
  async getCustomerStats(shopId: string): Promise<CustomerStats> {
    try {
      console.log(`[CUSTOMER-STATS] Fetching stats for shop ${shopId}`)

      // Query 1: Total customers
      const { data: totalCustomersData, error: totalError } = await supabase
        .from("shop_customers")
        .select("id", { count: "exact" })
        .eq("shop_id", shopId)

      if (totalError) throw totalError

      const total_customers = totalCustomersData?.length || 0

      // Query 2: Repeat customers
      const { data: repeatCustomersData, error: repeatError } = await supabase
        .from("shop_customers")
        .select("id", { count: "exact" })
        .eq("shop_id", shopId)
        .eq("repeat_customer", true)

      if (repeatError) throw repeatError

      const repeat_customers = repeatCustomersData?.length || 0

      // Query 3: New customers this month
      const monthAgo = new Date()
      monthAgo.setMonth(monthAgo.getMonth() - 1)

      const { data: newCustomersData, error: newError } = await supabase
        .from("shop_customers")
        .select("id", { count: "exact" })
        .eq("shop_id", shopId)
        .gte("first_purchase_at", monthAgo.toISOString())

      if (newError) throw newError

      const new_customers_month = newCustomersData?.length || 0

      // Query 4: Average LTV and total revenue (combined)
      const { data: ltcData, error: ltcError } = await supabase
        .from("shop_customers")
        .select("total_spent")
        .eq("shop_id", shopId)

      if (ltcError) throw ltcError

      const totalRevenue = ltcData?.reduce((sum, c) => sum + (c.total_spent || 0), 0) || 0
      const average_ltv = total_customers > 0 ? totalRevenue / total_customers : 0
      const total_revenue = totalRevenue

      const repeat_percentage =
        total_customers > 0 ? (repeat_customers / total_customers) * 100 : 0

      const stats: CustomerStats = {
        total_customers,
        repeat_customers,
        repeat_percentage: Math.round(repeat_percentage * 10) / 10, // 1 decimal place
        new_customers_month,
        average_ltv: Math.round(average_ltv * 100) / 100, // 2 decimal places
        total_revenue: Math.round(total_revenue * 100) / 100, // 2 decimal places
      }

      console.log(`[CUSTOMER-STATS] ✓ Stats computed:`, stats)
      return stats
    } catch (error) {
      console.error("[CUSTOMER-STATS] Error fetching customer stats:", error)
      throw error
    }
  },

  /**
   * Get list of customers for a shop
   */
  async listCustomers(shopId: string, limit = 50, offset = 0) {
    try {
      console.log(
        `[CUSTOMER-LIST] Fetching customers for shop ${shopId} (limit: ${limit}, offset: ${offset})`
      )

      const { data: customers, error, count } = await supabase
        .from("shop_customers")
        .select("*", { count: "exact" })
        .eq("shop_id", shopId)
        .order("last_purchase_at", { ascending: false })
        .range(offset, offset + limit - 1)

      if (error) throw error

      console.log(`[CUSTOMER-LIST] ✓ Found ${customers?.length || 0} customers`)

      return {
        customers: customers || [],
        total: count || 0,
        limit,
        offset,
      }
    } catch (error) {
      console.error("[CUSTOMER-LIST] Error fetching customers:", error)
      throw error
    }
  },

  /**
   * Get detailed history of a specific customer
   */
  async getCustomerHistory(customerId: string) {
    try {
      console.log(`[CUSTOMER-HISTORY] Fetching history for customer ${customerId}`)

      // Get customer details
      const { data: customer, error: customerError } = await supabase
        .from("shop_customers")
        .select("*")
        .eq("id", customerId)
        .single()

      if (customerError) throw customerError

      // Get all orders for this customer
      const { data: orders, error: ordersError } = await supabase
        .from("shop_orders")
        .select("*")
        .eq("shop_customer_id", customerId)
        .order("created_at", { ascending: false })

      if (ordersError) throw ordersError

      // Get tracking records
      const { data: tracking, error: trackingError } = await supabase
        .from("customer_tracking")
        .select("*")
        .eq("shop_customer_id", customerId)
        .order("accessed_at", { ascending: false })

      if (trackingError) throw trackingError

      console.log(
        `[CUSTOMER-HISTORY] ✓ Found ${orders?.length || 0} orders and ${tracking?.length || 0} tracking records`
      )

      return {
        customer,
        orders: orders || [],
        tracking: tracking || [],
      }
    } catch (error) {
      console.error("[CUSTOMER-HISTORY] Error fetching customer history:", error)
      throw error
    }
  },

  /**
   * Track customer from bulk/wallet order
   * Phone numbers from bulk orders are tracked as customers
   */
  async trackBulkOrderCustomer(input: {
    shopId: string
    phoneNumber: string
    orderId: string
    amount: number
    network: string
    volumeGb: number
  }) {
    try {
      const { shopId, phoneNumber, orderId, amount, network, volumeGb } = input

      console.log(
        `[BULK-CUSTOMER-TRACKING] Tracking bulk order customer: ${phoneNumber} for shop ${shopId}`
      )

      // Use the same trackCustomer logic but with "bulk_order" source
      const trackingResult = await this.trackCustomer({
        shopId,
        phoneNumber,
        email: null as any,
        customerName: `${network} ${volumeGb}GB`,
        totalPrice: amount,
        slug: "bulk_order",
      })

      console.log(
        `[BULK-CUSTOMER-TRACKING] ✓ Tracked bulk order customer: ${phoneNumber}, customerId: ${trackingResult.customerId}`
      )

      return {
        success: true,
        customerId: trackingResult.customerId,
        isRepeatCustomer: trackingResult.isRepeatCustomer,
      }
    } catch (error) {
      console.error("[BULK-CUSTOMER-TRACKING] ✗ Error tracking bulk order customer:", error)
      throw error
    }
  },

  /**
   * Get slug analytics for bulk orders (which networks/volumes are popular)
   */
  async getBulkOrderAnalytics(shopId: string) {
    try {
      console.log(`[BULK-ANALYTICS] Fetching bulk order analytics for shop ${shopId}`)

      const { data: customers, error } = await supabase
        .from("shop_customers")
        .select("preferred_network, total_purchases, total_spent")
        .eq("shop_id", shopId)
        .eq("first_source_slug", "bulk_order")

      if (error) throw error

      // Group by network
      const networkStats: {
        [key: string]: { total_customers: number; total_revenue: number; repeat_rate: number }
      } = {}

      customers?.forEach((customer: any) => {
        const network = customer.preferred_network || "Unknown"
        if (!networkStats[network]) {
          networkStats[network] = { total_customers: 0, total_revenue: 0, repeat_rate: 0 }
        }
        networkStats[network].total_customers += 1
        networkStats[network].total_revenue += customer.total_spent || 0
        if (customer.total_purchases > 1) {
          networkStats[network].repeat_rate += 1
        }
      })

      // Calculate repeat rates
      Object.keys(networkStats).forEach((network) => {
        networkStats[network].repeat_rate =
          networkStats[network].total_customers > 0
            ? (networkStats[network].repeat_rate / networkStats[network].total_customers) * 100
            : 0
      })

      console.log(
        `[BULK-ANALYTICS] ✓ Found bulk order data for ${Object.keys(networkStats).length} networks`
      )

      return networkStats
    } catch (error) {
      console.error("[BULK-ANALYTICS] Error fetching bulk order analytics:", error)
      throw error
    }
  },

  /**
   * Track customer from data packages page purchases
   * Similar to bulk orders but with different source tracking
   */
  async trackDataPackageCustomer(input: {
    shopId: string
    phoneNumber: string
    orderId: string
    amount: number
    network: string
    sizeGb: number
  }) {
    try {
      const { shopId, phoneNumber, orderId, amount, network, sizeGb } = input

      console.log(
        `[DATA-PACKAGE-TRACKING] Tracking data package customer: ${phoneNumber} for shop ${shopId}`
      )

      // Check if customer already exists
      const { data: existingCustomer, error: fetchError } = await supabase
        .from("shop_customers")
        .select("id, total_purchases, total_spent, repeat_customer")
        .eq("shop_id", shopId)
        .eq("phone_number", phoneNumber)
        .single()

      if (fetchError && fetchError.code !== "PGRST116") {
        throw fetchError
      }

      let customerId: string

      if (existingCustomer) {
        // UPDATE existing customer (repeat purchase)
        const newTotalSpent = (existingCustomer.total_spent || 0) + amount
        const newPurchases = (existingCustomer.total_purchases || 0) + 1

        console.log(
          `[DATA-PACKAGE-TRACKING] Repeat customer: ${phoneNumber} - Purchase #${newPurchases}`
        )

        const { data: updated, error: updateError } = await supabase
          .from("shop_customers")
          .update({
            last_purchase_at: new Date().toISOString(),
            total_purchases: newPurchases,
            total_spent: newTotalSpent,
            repeat_customer: newPurchases > 1,
            preferred_network: network,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existingCustomer.id)
          .select("id")
          .single()

        if (updateError) throw updateError

        customerId = existingCustomer.id
      } else {
        // CREATE new customer from data package purchase
        console.log(`[DATA-PACKAGE-TRACKING] New customer from data package: ${phoneNumber}`)

        const { data: newCustomer, error: insertError } = await supabase
          .from("shop_customers")
          .insert([
            {
              shop_id: shopId,
              phone_number: phoneNumber,
              email: null,
              customer_name: `${network} ${sizeGb}GB`,
              first_purchase_at: new Date().toISOString(),
              last_purchase_at: new Date().toISOString(),
              total_purchases: 1,
              total_spent: amount,
              repeat_customer: false,
              first_source_slug: "data_package",
              preferred_network: network,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ])
          .select("id")
          .single()

        if (insertError) throw insertError

        customerId = newCustomer.id
      }

      console.log(`[DATA-PACKAGE-TRACKING] ✓ Tracked customer ${customerId}`)

      return {
        success: true,
        customerId,
        isRepeatCustomer: !!existingCustomer,
      }
    } catch (error) {
      console.error("[DATA-PACKAGE-TRACKING] Error tracking data package customer:", error)
      throw error
    }
  },
}

```
