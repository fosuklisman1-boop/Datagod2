import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import * as XLSX from "xlsx"
import { type NotificationType } from "@/lib/notification-service"

// Initialize Supabase with service role key
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * Check if auto-fulfillment is enabled in admin settings
 */
async function isAutoFulfillmentEnabled(): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", "auto_fulfillment_enabled")
      .single()
    
    if (error || !data) {
      // Default to enabled if setting doesn't exist
      return true
    }
    
    return data.value?.enabled ?? true
  } catch (error) {
    console.warn("[DOWNLOAD] Error checking auto-fulfillment setting:", error)
    // Default to enabled on error
    return true
  }
}

export async function POST(request: NextRequest) {
  try {
    // Verify user is authenticated and is an admin
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized: Missing auth token" }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const { data: { user: callerUser }, error: callerError } = await supabase.auth.getUser(token)

    if (callerError || !callerUser) {
      return NextResponse.json({ error: "Unauthorized: Invalid token" }, { status: 401 })
    }

    // Check if caller is admin
    if (callerUser.user_metadata?.role !== "admin") {
      console.warn(`[DOWNLOAD] Unauthorized attempt by user ${callerUser.id}. Not an admin.`)
      return NextResponse.json({ error: "Forbidden: Admin access required" }, { status: 403 })
    }

    const { orderIds, orderType, isRedownload } = await request.json()

    console.log("[DOWNLOAD] Admin", callerUser.id, "downloading orders:", orderIds, "orderType:", orderType, "isRedownload:", isRedownload)

    if (!orderIds || orderIds.length === 0) {
      return NextResponse.json(
        { error: "No order IDs provided" },
        { status: 400 }
      )
    }

    // Check if auto-fulfillment is enabled (affects which networks can be downloaded)
    const autoFulfillEnabled = await isAutoFulfillmentEnabled()
    console.log(`[DOWNLOAD] Auto-fulfillment enabled: ${autoFulfillEnabled}`)

    let orders: any[] = []
    let bulkOrderIds: string[] = []
    let shopOrderIds: string[] = []

    // If orderType is specified (single type), use specific table
    if (orderType === "shop") {
      let shopQuery = supabase
        .from("shop_orders")
        .select("id, created_at, customer_phone, total_price, order_status, network, volume_gb")
        .in("id", orderIds)
      
      // If auto-fulfillment is enabled, exclude auto-fulfilled networks
      if (autoFulfillEnabled) {
        shopQuery = shopQuery
          .neq("network", "AT - iShare")
          .neq("network", "Telecel")
          .neq("network", "AT - BigTime")
      }

      const { data: shopOrders, error: fetchError } = await shopQuery

      if (fetchError) {
        throw new Error(`Failed to fetch shop orders: ${fetchError.message}`)
      }

      orders = shopOrders?.map((order: any) => ({
        id: order.id,
        created_at: order.created_at,
        phone_number: order.customer_phone,
        price: order.total_price,
        status: order.order_status,
        size: order.volume_gb,
        network: order.network,
        type: "shop"
      })) || []

      shopOrderIds = shopOrders?.map(o => o.id) || []
    } else if (orderType === "bulk") {
      let bulkQuery = supabase
        .from("orders")
        .select("id, created_at, phone_number, price, status, size, network")
        .in("id", orderIds)
      
      // If auto-fulfillment is enabled, exclude auto-fulfilled networks
      if (autoFulfillEnabled) {
        bulkQuery = bulkQuery
          .neq("network", "AT - iShare")
          .neq("network", "Telecel")
          .neq("network", "AT - BigTime")
      }

      const { data: bulkOrders, error: fetchError } = await bulkQuery

      if (fetchError) {
        throw new Error(`Failed to fetch orders: ${fetchError.message}`)
      }

      orders = bulkOrders?.map((order: any) => ({
        id: order.id,
        created_at: order.created_at,
        phone_number: order.phone_number,
        price: order.price,
        status: order.status,
        size: order.size,
        network: order.network,
        type: "bulk"
      })) || []
      bulkOrderIds = bulkOrders?.map(o => o.id) || []
    } else {
      // Mixed order types (or orderType not specified) - query both tables
      console.log("Fetching mixed bulk and shop orders...")

      // Build queries - conditionally exclude auto-fulfilled networks
      let bulkQueryBuilder = supabase
        .from("orders")
        .select("id, created_at, phone_number, price, status, size, network")
        .in("id", orderIds)
      
      let shopQueryBuilder = supabase
        .from("shop_orders")
        .select("id, created_at, customer_phone, total_price, order_status, network, volume_gb")
        .in("id", orderIds)
      
      if (autoFulfillEnabled) {
        bulkQueryBuilder = bulkQueryBuilder
          .neq("network", "AT - iShare")
          .neq("network", "Telecel")
          .neq("network", "AT - BigTime")
        shopQueryBuilder = shopQueryBuilder
          .neq("network", "AT - iShare")
          .neq("network", "Telecel")
          .neq("network", "AT - BigTime")
      }

      const [bulkResult, shopResult] = await Promise.all([bulkQueryBuilder, shopQueryBuilder])

      if (bulkResult.error) {
        throw new Error(`Failed to fetch bulk orders: ${bulkResult.error.message}`)
      }

      if (shopResult.error) {
        throw new Error(`Failed to fetch shop orders: ${shopResult.error.message}`)
      }

      // Map bulk orders
      const mappedBulkOrders = bulkResult.data?.map((order: any) => ({
        id: order.id,
        created_at: order.created_at,
        phone_number: order.phone_number,
        price: order.price,
        status: order.status,
        size: order.size,
        network: order.network,
        type: "bulk"
      })) || []

      // Map shop orders
      const mappedShopOrders = shopResult.data?.map((order: any) => ({
        id: order.id,
        created_at: order.created_at,
        phone_number: order.customer_phone,
        price: order.total_price,
        status: order.order_status,
        size: order.volume_gb,
        network: order.network,
        type: "shop"
      })) || []

      orders = [...mappedBulkOrders, ...mappedShopOrders]
      bulkOrderIds = mappedBulkOrders.map(o => o.id)
      shopOrderIds = mappedShopOrders.map(o => o.id)
    }

    console.log("[DOWNLOAD] Fetched orders:", orders.length, "Bulk:", bulkOrderIds.length, "Shop:", shopOrderIds.length)

    if (!orders || orders.length === 0) {
      console.error("[DOWNLOAD] No orders found after querying")
      return NextResponse.json(
        { error: "No orders found" },
        { status: 404 }
      )
    }

    // RACE CONDITION PREVENTION:
    // Update order statuses atomically with status check to prevent duplicate downloads
    // Only orders still in "pending" status will be updated and included
    // Only update status to "processing" on initial download, not on redownloads
    if (!isRedownload) {
      let actualBulkOrderIds: string[] = []
      let actualShopOrderIds: string[] = []

      if (bulkOrderIds.length > 0) {
        // Use update with WHERE clause to only update pending orders
        // This returns only the orders that were actually updated (still pending)
        const { data: updatedBulk, error: updateError } = await supabase
          .from("orders")
          .update({ status: "processing", updated_at: new Date().toISOString() })
          .in("id", bulkOrderIds)
          .eq("status", "pending")  // Only update if still pending!
          .select("id")

        if (updateError) {
          throw new Error(`Failed to update bulk order status: ${updateError.message}`)
        }

        actualBulkOrderIds = updatedBulk?.map(o => o.id) || []
        console.log(`[DOWNLOAD] Bulk orders claimed: ${actualBulkOrderIds.length} of ${bulkOrderIds.length} requested`)

        // Filter orders to only include those that were actually claimed
        if (actualBulkOrderIds.length < bulkOrderIds.length) {
          const skippedCount = bulkOrderIds.length - actualBulkOrderIds.length
          console.warn(`[DOWNLOAD] ${skippedCount} bulk orders were already downloaded by another admin`)
        }
      }

      if (shopOrderIds.length > 0) {
        // Use update with WHERE clause to only update pending orders
        const { data: updatedShop, error: updateError } = await supabase
          .from("shop_orders")
          .update({ order_status: "processing", updated_at: new Date().toISOString() })
          .in("id", shopOrderIds)
          .eq("order_status", "pending")  // Only update if still pending!
          .select("id")

        if (updateError) {
          throw new Error(`Failed to update shop order status: ${updateError.message}`)
        }

        actualShopOrderIds = updatedShop?.map(o => o.id) || []
        console.log(`[DOWNLOAD] Shop orders claimed: ${actualShopOrderIds.length} of ${shopOrderIds.length} requested`)

        if (actualShopOrderIds.length < shopOrderIds.length) {
          const skippedCount = shopOrderIds.length - actualShopOrderIds.length
          console.warn(`[DOWNLOAD] ${skippedCount} shop orders were already downloaded by another admin`)
        }
      }

      // Filter the orders list to only include successfully claimed orders
      const claimedOrderIds = new Set([...actualBulkOrderIds, ...actualShopOrderIds])
      orders = orders.filter((order: any) => claimedOrderIds.has(order.id))
      bulkOrderIds = actualBulkOrderIds
      shopOrderIds = actualShopOrderIds

      // Update status in the filtered orders
      orders.forEach((order: any) => {
        order.status = "processing"
      })

      // If no orders were claimed (all taken by another admin), return appropriate error
      if (orders.length === 0) {
        return NextResponse.json(
          { error: "These orders were already downloaded by another admin", alreadyDownloaded: true },
          { status: 409 }  // 409 Conflict
        )
      }
    }

    // Send processing notifications to users (only on initial download, not redownloads)
    if (!isRedownload) {
      try {
        // Get user info for all orders to send notifications
        const bulkOrdersWithUsers = bulkOrderIds.length > 0 
          ? await supabase
              .from("orders")
              .select("id, user_id, network, size, phone_number")
              .in("id", bulkOrderIds)
          : { data: [] }

        const shopOrdersWithUsers = shopOrderIds.length > 0
          ? await supabase
              .from("shop_orders")
              .select("id, user_id, network, volume_gb, phone_number")
              .in("id", shopOrderIds)
          : { data: [] }

        const allOrdersWithUsers = [
          ...(bulkOrdersWithUsers.data || []).map(o => ({ ...o, type: "bulk", size: o.size })),
          ...(shopOrdersWithUsers.data || []).map(o => ({ ...o, type: "shop", size: o.volume_gb }))
        ]

        for (const order of allOrdersWithUsers) {
          try {
            const { error: notifError } = await supabase
              .from("notifications")
              .insert([
                {
                  user_id: order.user_id,
                  title: "Order Processing",
                  message: `Your ${order.network} ${order.size}GB data order is now being processed. Phone: ${order.phone_number}`,
                  type: "order_update" as NotificationType,
                  reference_id: order.id,
                  action_url: order.type === "shop" ? `/dashboard/shop-orders` : `/dashboard/my-orders`,
                  read: false,
                },
              ])

            if (notifError) {
              console.warn(`[DOWNLOAD] Failed to send processing notification for order ${order.id}:`, notifError)
            }
          } catch (notifError) {
            console.warn(`[DOWNLOAD] Error sending notification for order ${order.id}:`, notifError)
          }
        }
        console.log(`[DOWNLOAD] ✓ Sent processing notifications for ${allOrdersWithUsers.length} orders`)
      } catch (notifError) {
        console.warn("[DOWNLOAD] Error sending notifications:", notifError)
      }
    }

    // Group orders by network
    const groupedByNetwork: { [key: string]: any[] } = {}
    orders.forEach((order: any) => {
      if (!groupedByNetwork[order.network]) {
        groupedByNetwork[order.network] = []
      }
      groupedByNetwork[order.network].push(order)
    })

    // Create download batch record
    const batchTime = new Date().toISOString()
    const batchRecords = Object.entries(groupedByNetwork).map(([network, networkOrders]) => ({
      network,
      batch_time: batchTime,
      orders: networkOrders,
      order_count: networkOrders.length,
      created_at: batchTime
    }))

    // Insert batch records
    const { error: batchError } = await supabase
      .from("order_download_batches")
      .insert(batchRecords)

    if (batchError) {
      console.warn("Warning: Could not create batch records:", batchError.message)
      // Continue anyway - batch tracking is optional
    }

    // Generate Excel file
    const excelData = orders.map((order: any) => ({
      Phone: order.phone_number,
      Size: order.size?.toString().replace(/[^0-9]/g, "") || order.size // Remove "GB" or any non-numeric characters
    }))

    const worksheet = XLSX.utils.json_to_sheet(excelData)
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, "Orders")

    // Set column widths
    worksheet["!cols"] = [
      { wch: 15 }, // Phone column
      { wch: 10 }  // Size column
    ]

    const excelBuffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" })

    // Generate filename with date and time
    const now = new Date()
    const dateTime = now.toISOString().replace(/[:.]/g, '-').split('Z')[0] // Converts to YYYY-MM-DDTHH-mm-ss format
    const fileName = `orders-${dateTime}.xlsx`

    return new NextResponse(excelBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`
      }
    })
  } catch (error) {
    console.error("Error in download orders:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
