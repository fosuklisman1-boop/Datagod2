import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import * as XLSX from "xlsx"
import { type NotificationType } from "@/lib/notification-service"
import { verifyAdminAccess } from "@/lib/admin-auth"

// Initialize Supabase with service role key
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

// A large pending backlog (thousands of orders) needs room to claim + notify +
// build the workbook; without this the function times out mid-request and the
// browser reports "Failed to fetch".
export const maxDuration = 300

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
  const { isAdmin, errorResponse, userId: callerUserId, userEmail: callerEmail } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { orderIds: providedIds, orderType, isRedownload, filters } = await request.json()
    let orderIds = providedIds || []

    console.log("[DOWNLOAD] Admin", callerUserId, "downloading. Filters:", !!filters, "OrderIds count:", orderIds.length)

    // Check if auto-fulfillment is enabled (affects which networks can be downloaded)
    const autoFulfillEnabled = await isAutoFulfillmentEnabled()
    console.log(`[DOWNLOAD] Auto-fulfillment enabled: ${autoFulfillEnabled}`)

    // Failed orders download — export-only, no claim/batch record
    if (filters?.failureMode === "failed") {
      // Step 1: fetch all failed tracking rows, sorted newest-first
      const { data: failedTracking } = await supabase
        .from("mtn_fulfillment_tracking")
        .select("shop_order_id, order_id, api_order_id, status, created_at")
        .eq("status", "failed")
        .order("created_at", { ascending: false })

      // Dedupe: keep only the latest tracking row per order (skip if a later attempt succeeded)
      const latestPerOrder = new Map<string, string>()
      for (const t of failedTracking || []) {
        const id = t.shop_order_id || t.order_id || t.api_order_id
        if (id && !latestPerOrder.has(id)) latestPerOrder.set(id, t.status)
      }
      const failedOrderIds = Array.from(latestPerOrder.keys())

      // Build a reusable base query with date/network/time filters
      const buildQuery = () => {
        let q = supabase.from("combined_orders_view").select("*")
        if (filters.date) {
          q = q.gte("created_at", `${filters.date}T00:00:00Z`)
          q = q.lte("created_at", `${filters.date}T23:59:59Z`)
        }
        if (filters.startTime || filters.endTime) {
          const d = filters.date || new Date().toISOString().split("T")[0]
          if (filters.startTime) q = q.gte("created_at", `${d}T${filters.startTime}:00Z`)
          if (filters.endTime) q = q.lte("created_at", `${d}T${filters.endTime}:59Z`)
        }
        if (filters.network && filters.network !== "all") q = q.eq("network", filters.network)
        if (autoFulfillEnabled) {
          q = q.neq("network", "AT - iShare").neq("network", "Telecel").neq("network", "AT - BigTime")
        }
        return q
      }

      const seenIds = new Set<string>()
      const failedOrders: any[] = []

      // Query A: orders whose latest tracking row is "failed"
      if (failedOrderIds.length > 0) {
        const { data: queryA } = await buildQuery().in("id", failedOrderIds)
        for (const o of queryA || []) {
          if (!seenIds.has(o.id)) { seenIds.add(o.id); failedOrders.push(o) }
        }
      }

      // Query B: orders still carrying status="failed" in the view (historical, pre-PR)
      const { data: queryB } = await buildQuery().eq("status", "failed")
      for (const o of queryB || []) {
        if (!seenIds.has(o.id)) { seenIds.add(o.id); failedOrders.push(o) }
      }

      if (failedOrders.length === 0) {
        return NextResponse.json({ error: "No orders found" }, { status: 404 })
      }

      console.log(`[DOWNLOAD] Failed orders export: ${failedOrders.length} orders`)

      const excelData = failedOrders.map((order: any) => {
        const cleanSizeStr = order.volume_gb?.toString().replace(/[^0-9.]/g, "")
        const parsedSize = parseFloat(cleanSizeStr)
        return {
          Phone: order.phone_number,
          Size: !isNaN(parsedSize) ? parsedSize : (order.volume_gb || "")
        }
      })

      const worksheet = XLSX.utils.json_to_sheet(excelData)
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, worksheet, "Orders")
      worksheet["!cols"] = [{ wch: 15 }, { wch: 10 }]

      const excelBuffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" })
      const now = new Date()
      const dateTime = now.toISOString().replace(/[:.]/g, "-").split("Z")[0]
      const networkSlug = filters.network && filters.network !== "all" ? filters.network : "all"
      const dateSlug = filters.date || "unknown"
      const fileName = `orders-failed-${networkSlug}-${dateSlug}-${dateTime}.xlsx`

      return new NextResponse(excelBuffer, {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${fileName}"`
        }
      })
    }

    let orders: any[] = []
    let bulkOrderIds: string[] = []
    let shopOrderIds: string[] = []

    // 1. Fetch data from View if filters or orderIds are provided
    let query = supabase
      .from("combined_orders_view")
      .select("*")

    if (filters && orderIds.length === 0) {
      if (filters.date) {
        const date = filters.date
        query = query.gte("created_at", `${date}T00:00:00Z`)
        query = query.lte("created_at", `${date}T23:59:59Z`)
      }
      if (filters.network && filters.network !== "all") {
        query = query.eq("network", filters.network)
      }
      if (filters.startTime || filters.endTime) {
        const date = filters.date || new Date().toISOString().split('T')[0]
        if (filters.startTime) {
          query = query.gte("created_at", `${date}T${filters.startTime}:00Z`)
        }
        if (filters.endTime) {
          query = query.lte("created_at", `${date}T${filters.endTime}:59Z`)
        }
      }
      if (filters.onlyPending) {
        query = query.eq("status", "pending")
      }
    } else {
      // Use provided IDs
      query = query.in("id", orderIds)
    }

    // Filter by order type if specified
    if (orderType && orderType !== "all") {
      query = query.eq("type", orderType)
    }

    // Exclude auto-fulfilled networks if auto-fulfillment is enabled
    if (autoFulfillEnabled) {
      query = query
        .neq("network", "AT - iShare")
        .neq("network", "Telecel")
        .neq("network", "AT - BigTime")
    }

    const { data: fetchResult, error: fetchError } = await query

    if (fetchError) {
      throw new Error(`Failed to fetch orders for download: ${fetchError.message}`)
    }

    orders = (fetchResult || []).map(order => ({
      ...order,
      size: order.volume_gb // map volume_gb to size for Excel generation consistency
    }))

    bulkOrderIds = orders.filter(o => o.type === "bulk").map(o => o.id)
    shopOrderIds = orders.filter(o => o.type === "shop").map(o => o.id)
    let ussdOrderIds: string[] = orders.filter(o => o.type === "ussd").map(o => o.id)
    let ussdShopOrderIds: string[] = orders.filter(o => o.type === "ussd_shop").map(o => o.id)
    let apiOrderIds: string[] = orders.filter(o => o.type === "api").map(o => o.id)
    orderIds = orders.map(o => o.id)

    console.log("[DOWNLOAD] Fetched orders:", orders.length, "Bulk:", bulkOrderIds.length, "Shop:", shopOrderIds.length, "USSD:", ussdOrderIds.length, "USSD Shop:", ussdShopOrderIds.length, "API:", apiOrderIds.length)

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
          .eq("status", "pending")
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
          .eq("order_status", "pending")
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

      let actualUssdOrderIds: string[] = []
      if (ussdOrderIds.length > 0) {
        const { data: updatedUssd, error: ussdUpdateError } = await supabase
          .from("ussd_orders")
          .update({ order_status: "processing", updated_at: new Date().toISOString() })
          .in("id", ussdOrderIds)
          .eq("order_status", "pending")
          .select("id")

        if (ussdUpdateError) {
          throw new Error(`Failed to update USSD order status: ${ussdUpdateError.message}`)
        }

        actualUssdOrderIds = updatedUssd?.map(o => o.id) || []
        console.log(`[DOWNLOAD] USSD orders claimed: ${actualUssdOrderIds.length} of ${ussdOrderIds.length} requested`)
      }

      let actualUssdShopOrderIds: string[] = []
      if (ussdShopOrderIds.length > 0) {
        const { data: updatedUssdShop, error: ussdShopUpdateError } = await supabase
          .from("ussd_shop_orders")
          .update({ order_status: "processing", updated_at: new Date().toISOString() })
          .in("id", ussdShopOrderIds)
          .eq("order_status", "pending")
          .select("id")

        if (ussdShopUpdateError) {
          throw new Error(`Failed to update USSD shop order status: ${ussdShopUpdateError.message}`)
        }

        actualUssdShopOrderIds = updatedUssdShop?.map(o => o.id) || []
        console.log(`[DOWNLOAD] USSD shop orders claimed: ${actualUssdShopOrderIds.length} of ${ussdShopOrderIds.length} requested`)
      }

      let actualApiOrderIds: string[] = []
      if (apiOrderIds.length > 0) {
        const { data: updatedApi, error: apiUpdateError } = await supabase
          .from("api_orders")
          .update({ status: "processing", updated_at: new Date().toISOString() })
          .in("id", apiOrderIds)
          .eq("status", "pending")
          .select("id")

        if (apiUpdateError) {
          throw new Error(`Failed to update API order status: ${apiUpdateError.message}`)
        }

        actualApiOrderIds = updatedApi?.map(o => o.id) || []
        console.log(`[DOWNLOAD] API orders claimed: ${actualApiOrderIds.length} of ${apiOrderIds.length} requested`)

        if (actualApiOrderIds.length < apiOrderIds.length) {
          const skippedCount = apiOrderIds.length - actualApiOrderIds.length
          console.warn(`[DOWNLOAD] ${skippedCount} API orders were already downloaded by another admin`)
        }
      }

      // Filter the orders list to only include successfully claimed orders
      const claimedOrderIds = new Set([...actualBulkOrderIds, ...actualShopOrderIds, ...actualUssdOrderIds, ...actualUssdShopOrderIds, ...actualApiOrderIds])
      orders = orders.filter((order: any) => claimedOrderIds.has(order.id))
      bulkOrderIds = actualBulkOrderIds
      shopOrderIds = actualShopOrderIds
      ussdOrderIds = actualUssdOrderIds
      ussdShopOrderIds = actualUssdShopOrderIds
      apiOrderIds = actualApiOrderIds

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

        // BATCH the inserts (was one round-trip PER order — the main cause of the
        // "Failed to fetch" timeout on a large backlog). Chunk to stay under payload
        // limits, and only notify orders that actually have a user_id.
        const notifRows = allOrdersWithUsers
          .filter(o => o.user_id)
          .map(order => ({
            user_id: order.user_id,
            title: "Order Processing",
            message: `Your ${order.network} ${order.size}GB data order is now being processed. Phone: ${order.phone_number}`,
            type: "order_update" as NotificationType,
            reference_id: order.id,
            action_url: order.type === "shop" ? `/dashboard/shop-orders` : `/dashboard/my-orders`,
            read: false,
          }))
        for (let i = 0; i < notifRows.length; i += 500) {
          const { error: notifError } = await supabase.from("notifications").insert(notifRows.slice(i, i + 500))
          if (notifError) console.warn("[DOWNLOAD] Batch notification insert failed:", notifError.message)
        }
        console.log(`[DOWNLOAD] ✓ Sent processing notifications for ${notifRows.length} orders`)
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
      created_at: batchTime,
      downloaded_by: callerUserId,
      downloaded_by_email: callerEmail || "Unknown"
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
    const excelData = orders.map((order: any) => {
      const cleanSizeStr = order.size?.toString().replace(/[^0-9.]/g, "");
      const parsedSize = parseFloat(cleanSizeStr);
      return {
        Phone: order.phone_number,
        Size: !isNaN(parsedSize) ? parsedSize : (order.size || "") // Remove "GB", format as number to drop trailing .00
      };
    })

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
