import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import * as XLSX from "xlsx"
import { verifyAdminAccess } from "@/lib/admin-auth"

export async function POST(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  const { isAdmin, userId: adminId, userEmail: adminEmail, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
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
        users!airtime_orders_user_id_fkey_public(email),
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
      downloaded_by: adminId,
      downloaded_by_email: adminEmail
    }))

    // 5. Insert batches
    const { error: batchError } = await supabase
      .from("airtime_download_batches")
      .insert(batchRecords)
    
    if (batchError) console.error("[AIRTIME-DOWNLOAD] Batch record error:", batchError)

    // 6. Generate Excel
    const excelData = orders.map(o => {
      // Handle potential aliasing in the Supabase results
      const userData = (o as any).users || (o as any)["users!airtime_orders_user_id_fkey_public"]
      const user = Array.isArray(userData) ? userData[0] : userData
      
      const shopData = (o as any).user_shops
      const shop = Array.isArray(shopData) ? shopData[0] : shopData
      
      return {
        Reference: o.reference_code,
        Network: o.network,
        Phone: o.beneficiary_phone,
        Amount: o.airtime_amount,
        Customer: user?.email || o.customer_email || o.customer_name || "Guest",
        Shop: shop?.shop_name || "Direct",
        Date: new Date(o.created_at).toLocaleString()
      }
    })

    const worksheet = XLSX.utils.json_to_sheet(excelData)
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, "Airtime_Orders")

    const excelBuffer = XLSX.write(workbook, { bookType: "xlsx", type: "array" })
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
