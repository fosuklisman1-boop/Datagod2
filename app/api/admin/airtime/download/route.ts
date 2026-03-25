import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import * as XLSX from "xlsx"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  try {
    // 1. Auth check
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const { data: { user: adminUser }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !adminUser || adminUser.user_metadata?.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const { orderIds, isRedownload } = await request.json()

    // 2. Fetch orders
    let query = supabase
      .from("airtime_orders")
      .select(`
        id, 
        reference_code, 
        network, 
        beneficiary_phone, 
        airtime_amount, 
        total_paid, 
        status, 
        created_at,
        customer_name,
        customer_email,
        users(email),
        user_shops(shop_name)
      `)
    
    if (orderIds && orderIds.length > 0) {
      query = query.in("id", orderIds)
    } else {
      query = query.eq("status", "pending")
    }

    const { data: orders, error: fetchError } = await query
    if (fetchError || !orders || orders.length === 0) {
      return NextResponse.json({ error: "No orders found to download" }, { status: 404 })
    }

    // 3. Update status (if not a redownload)
    if (!isRedownload) {
      const pendingIds = orders.filter(o => o.status === "pending").map(o => o.id)
      if (pendingIds.length > 0) {
        const { error: updateError } = await supabase
          .from("airtime_orders")
          .update({ status: "processing", updated_at: new Date().toISOString() })
          .in("id", pendingIds)
        
        if (updateError) {
          console.error("[AIRTIME-DOWNLOAD] Status update error:", updateError)
        }
      }
    }

    // 4. Group by network for batch records
    const grouped: Record<string, any[]> = {}
    orders.forEach(o => {
      if (!grouped[o.network]) grouped[o.network] = []
      grouped[o.network].push(o)
    })

    const batchTime = new Date().toISOString()
    const batchRecords = Object.entries(grouped).map(([network, netOrders]) => ({
      network,
      batch_time: batchTime,
      orders: netOrders,
      order_count: netOrders.length,
      downloaded_by: adminUser.id,
      downloaded_by_email: adminUser.email
    }))

    // 5. Insert batches
    const { error: batchError } = await supabase
      .from("airtime_download_batches")
      .insert(batchRecords)
    
    if (batchError) console.error("[AIRTIME-DOWNLOAD] Batch record error:", batchError)

    // 6. Generate Excel
    const excelData = orders.map(o => ({
      Reference: o.reference_code,
      Network: o.network,
      Phone: o.beneficiary_phone,
      Amount: o.airtime_amount,
      Customer: o.users?.email || o.customer_email || o.customer_name || "Guest",
      Shop: o.user_shops?.shop_name || "Direct",
      Date: new Date(o.created_at).toLocaleString()
    }))

    const worksheet = XLSX.utils.json_to_sheet(excelData)
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, "Airtime_Orders")

    const excelBuffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" })
    const fileName = `airtime-orders-${new Date().toISOString().split('T')[0]}.xlsx`

    return new NextResponse(excelBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`
      }
    })

  } catch (error) {
    console.error("[AIRTIME-DOWNLOAD] Internal Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
