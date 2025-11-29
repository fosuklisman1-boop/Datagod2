import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import * as XLSX from "xlsx"

// Initialize Supabase with service role key
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

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

    const { orderIds, orderType } = await request.json()

    console.log("[DOWNLOAD] Admin", callerUser.id, "downloading orders:", orderIds, "orderType:", orderType)

    if (!orderIds || orderIds.length === 0) {
      return NextResponse.json(
        { error: "No order IDs provided" },
        { status: 400 }
      )
    }

    let orders: any[] = []
    let bulkOrderIds: string[] = []
    let shopOrderIds: string[] = []

    // If orderType is specified (single type), use original logic
    if (orderType === "shop" || orderType === "bulk") {
      if (orderType === "shop") {
        const { data: shopOrders, error: fetchError } = await supabase
          .from("shop_orders")
          .select("id, created_at, customer_phone, total_price, order_status, network, volume_gb")
          .in("id", orderIds)

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

        shopOrderIds = orderIds
      } else {
        const { data: bulkOrders, error: fetchError } = await supabase
          .from("orders")
          .select("id, created_at, phone_number, price, status, size, network")
          .in("id", orderIds)

        if (fetchError) {
          throw new Error(`Failed to fetch orders: ${fetchError.message}`)
        }

        orders = bulkOrders || []
        bulkOrderIds = orderIds
      }
    } else {
      // Mixed order types - query both tables
      console.log("Fetching mixed bulk and shop orders...")

      // Try to fetch from both tables
      const [bulkResult, shopResult] = await Promise.all([
        supabase
          .from("orders")
          .select("id, created_at, phone_number, price, status, size, network")
          .in("id", orderIds),
        supabase
          .from("shop_orders")
          .select("id, created_at, customer_phone, total_price, order_status, network, volume_gb")
          .in("id", orderIds)
      ])

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

    // Update order statuses - handle both types
    if (bulkOrderIds.length > 0) {
      const { error: updateError } = await supabase
        .from("orders")
        .update({ status: "processing" })
        .in("id", bulkOrderIds)

      if (updateError) {
        throw new Error(`Failed to update bulk order status: ${updateError.message}`)
      }
    }

    if (shopOrderIds.length > 0) {
      const { error: updateError } = await supabase
        .from("shop_orders")
        .update({ order_status: "processing" })
        .in("id", shopOrderIds)

      if (updateError) {
        throw new Error(`Failed to update shop order status: ${updateError.message}`)
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
      Size: order.size
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
