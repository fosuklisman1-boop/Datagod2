import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const [bulkResult, shopResult, apiResult, ussdResult, ussdShopResult] = await Promise.all([
      supabase
        .from("orders")
        .select("id, created_at, phone_number, price, status, size, network")
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .range(0, 9999),
      supabase
        .from("shop_orders")
        .select("id, created_at, customer_phone, total_price, order_status, volume_gb, network")
        .eq("order_status", "pending")
        .eq("payment_status", "completed")
        .order("created_at", { ascending: false })
        .range(0, 9999),
      supabase
        .from("api_orders")
        .select("id, created_at, recipient_phone, price, status, volume_gb, network")
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .range(0, 9999),
      supabase
        .from("ussd_orders")
        .select("id, created_at, recipient_phone, amount, order_status, package_size, network")
        .eq("order_status", "pending")
        .eq("payment_status", "completed")
        .order("created_at", { ascending: false })
        .range(0, 9999),
      supabase
        .from("ussd_shop_orders")
        .select("id, created_at, recipient_phone, amount, order_status, package_size, network")
        .eq("order_status", "pending")
        .eq("payment_status", "completed")
        .order("created_at", { ascending: false })
        .range(0, 9999),
    ])

    const allOrders = [
      ...(bulkResult.data || []).map(o => ({ id: o.id, phone_number: o.phone_number, network: o.network, size: o.size, price: o.price, status: o.status, created_at: o.created_at, type: "bulk" })),
      ...(shopResult.data || []).map(o => ({ id: o.id, phone_number: o.customer_phone, network: o.network, size: o.volume_gb, price: o.total_price, status: o.order_status, created_at: o.created_at, type: "shop" })),
      ...(apiResult.data || []).map(o => ({ id: o.id, phone_number: o.recipient_phone, network: o.network, size: o.volume_gb, price: o.price, status: o.status, created_at: o.created_at, type: "api" })),
      ...(ussdResult.data || []).map(o => ({ id: o.id, phone_number: o.recipient_phone, network: o.network, size: o.package_size, price: o.amount, status: o.order_status, created_at: o.created_at, type: "ussd" })),
      ...(ussdShopResult.data || []).map(o => ({ id: o.id, phone_number: o.recipient_phone, network: o.network, size: o.package_size, price: o.amount, status: o.order_status, created_at: o.created_at, type: "ussd_shop" })),
    ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    return NextResponse.json({ success: true, data: allOrders, count: allOrders.length })
  } catch (error) {
    console.error("Error fetching all pending orders:", error)
    return NextResponse.json({ error: error instanceof Error ? error.message : "Internal server error", success: false }, { status: 500 })
  }
}
