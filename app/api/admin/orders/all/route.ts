import { NextResponse, NextRequest } from "next/server"
import { createClient } from "@supabase/supabase-js"

// Initialize Supabase with service role key
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

// Normalize network names to title case
function normalizeNetwork(network: string): string {
  if (!network) return network
  const networkMap: { [key: string]: string } = {
    "mtn": "MTN",
    "telecel": "Telecel",
    "at": "AT",
    "at - ishare": "AT - iShare",
    "at - bigtime": "AT - BigTime",
    "ishare": "iShare",
  }
  const lower = network.toLowerCase().trim()
  return networkMap[lower] || network.toUpperCase().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const searchQuery = searchParams.get("search") || ""
    const searchType = searchParams.get("searchType") || "all" // "all", "reference", "phone"

    console.log(`Fetching all orders with search: "${searchQuery}" (type: ${searchType})`)

    // Fetch all bulk orders (any status) with pagination
    let bulkOrdersQuery = supabase
      .from("orders")
      .select("id, created_at, phone_number, price, status, size, network, transaction_code, order_code")
      .order("created_at", { ascending: false })

    // Apply search filter to DB query if present
    if (searchQuery) {
      const q = searchQuery.trim()
      if (searchType === "phone") {
        bulkOrdersQuery = bulkOrdersQuery.ilike("phone_number", `%${q}%`)
      } else if (searchType === "reference") {
        bulkOrdersQuery = bulkOrdersQuery.or(`transaction_code.ilike.%${q}%,order_code.ilike.%${q}%`)
      } else {
        // all
        bulkOrdersQuery = bulkOrdersQuery.or(`phone_number.ilike.%${q}%,transaction_code.ilike.%${q}%,order_code.ilike.%${q}%`)
      }
    }

    // Apply range limit (pagination)
    bulkOrdersQuery = bulkOrdersQuery.range(0, 9999)

    const { data: bulkOrders, error: bulkError } = await bulkOrdersQuery

    if (bulkError) {
      console.error("Supabase error fetching bulk orders:", bulkError)
      throw new Error(`Failed to fetch orders: ${bulkError.message}`)
    }

    console.log(`Found ${bulkOrders?.length || 0} bulk orders`)

    // Fetch all shop orders (any status) with pagination
    let shopOrdersQuery = supabase
      .from("shop_orders")
      .select(`
        id,
        created_at,
        customer_phone,
        customer_email,
        total_price,
        order_status,
        volume_gb,
        network,
        reference_code,
        payment_status,
        transaction_id,
        shop_id,
        user_shops!shop_id (
          shop_name,
          user_id
        )
      `)
      .order("created_at", { ascending: false })

    if (searchQuery) {
      const q = searchQuery.trim()
      if (searchType === "phone") {
        shopOrdersQuery = shopOrdersQuery.ilike("customer_phone", `%${q}%`)
      } else if (searchType === "reference") {
        shopOrdersQuery = shopOrdersQuery.or(`transaction_id.ilike.%${q}%,reference_code.ilike.%${q}%`)
      } else {
        shopOrdersQuery = shopOrdersQuery.or(`customer_phone.ilike.%${q}%,transaction_id.ilike.%${q}%,reference_code.ilike.%${q}%`)
      }
    }

    const { data: shopOrdersData, error: shopError } = await shopOrdersQuery
      .range(0, 9999)

    if (shopError) {
      console.error("Supabase error fetching shop orders:", shopError)
      throw new Error(`Failed to fetch shop orders: ${shopError.message}`)
    }

    // Get shop owner emails from auth.users table
    const userIds = [...new Set((shopOrdersData || []).map((o: any) => o.user_shops?.user_id).filter(Boolean))]
    let userEmails: { [key: string]: string } = {}

    if (userIds.length > 0) {
      const { data: authUsers } = await supabase.auth.admin.listUsers()
      if (authUsers?.users) {
        userEmails = Object.fromEntries(
          authUsers.users
            .filter(u => userIds.includes(u.id))
            .map(u => [u.id, u.email || "-"])
        )
      }
    }

    console.log(`Found ${shopOrdersData?.length || 0} shop orders`)

    // Fetch wallet payments to get Paystack references with pagination
    let walletQuery = supabase
      .from("wallet_payments")
      .select(`
        id,
        reference,
        user_id,
        created_at,
        status,
        amount,
        fee,
        shop_id,
        order_id
      `)
      .order("created_at", { ascending: false })

    if (searchQuery) {
      const q = searchQuery.trim()
      if (searchType === "reference" || searchType === "all") {
        walletQuery = walletQuery.ilike("reference", `%${q}%`)
      } else if (searchType === "phone") {
        walletQuery = walletQuery.eq("id", -1)
      }
    }

    const { data: walletPayments, error: walletPaymentsError } = await walletQuery
      .range(0, 9999)

    if (walletPaymentsError) {
      console.error("Supabase error fetching wallet payments:", walletPaymentsError)
      // Don't throw - wallet payments are optional for search
    }

    // Format bulk orders
    const formattedBulkOrders = (bulkOrders || []).map((order: any) => ({
      id: order.id,
      type: "bulk",
      phone_number: order.phone_number,
      network: normalizeNetwork(order.network),
      volume_gb: order.size,
      price: order.price,
      status: order.status,
      payment_status: "completed", // Bulk orders are paid via wallet balance at order creation
      payment_reference: order.transaction_code || order.order_code || "-",
      created_at: order.created_at,
    }))

    // Format shop orders
    const formattedShopOrders = (shopOrdersData || []).map((order: any) => ({
      id: order.id,
      type: "shop",
      phone_number: order.customer_phone || "-",
      customer_email: order.customer_email || "-",
      shop_owner_email: userEmails[order.user_shops?.user_id] || "-",
      store_name: order.user_shops?.shop_name || "-",
      network: normalizeNetwork(order.network),
      volume_gb: order.volume_gb,
      price: order.total_price,
      status: order.order_status,
      payment_status: order.payment_status,
      payment_reference: order.transaction_id || order.reference_code || "-",
      created_at: order.created_at,
    }))

    // Format wallet payments (for tracking Paystack payments)
    const formattedWalletPayments = (walletPayments || []).map((payment: any) => ({
      id: payment.id,
      type: "wallet_payment",
      phone_number: "-", // Wallet payments don't have direct phone reference
      network: "Wallet Top-up",
      volume_gb: 0,
      price: payment.amount,
      status: payment.status,
      payment_status: "completed", // Wallet orders are always completed instantly
      payment_reference: payment.reference || "-",
      created_at: payment.created_at,
    }))

    // Combine all orders and sort by created_at (newest first)
    let allOrders = [...formattedBulkOrders, ...formattedShopOrders, ...formattedWalletPayments]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    // Apply search filter
    // Note: Search filtering is now done at the database level for performance and accuracy across the entire dataset.
    // The previous in-memory filtering code has been removed.

    console.log(`Returning ${allOrders.length} filtered orders`)

    return NextResponse.json({
      success: true,
      count: allOrders.length,
      data: allOrders,
    })
  } catch (error) {
    console.error("Error in GET /api/admin/orders/all:", error)
    const errorMessage = "Failed to load orders. Please try again."
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    )
  }
}
