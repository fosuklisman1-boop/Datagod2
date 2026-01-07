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
      .range(0, 9999) // Paginate instead of unlimited

    const { data: bulkOrders, error: bulkError } = await bulkOrdersQuery

    if (bulkError) {
      console.error("Supabase error fetching bulk orders:", bulkError)
      throw new Error(`Failed to fetch orders: ${bulkError.message}`)
    }

    console.log(`Found ${bulkOrders?.length || 0} bulk orders`)

    // Fetch all shop orders (any status) with pagination
    const { data: shopOrdersData, error: shopError } = await supabase
      .from("shop_orders")
      .select(`
        id,
        created_at,
        customer_phone,
        total_price,
        order_status,
        volume_gb,
        network,
        reference_code,
        payment_status,
        transaction_id
      `)
      .order("created_at", { ascending: false })
      .range(0, 9999) // Paginate instead of unlimited

    if (shopError) {
      console.error("Supabase error fetching shop orders:", shopError)
      throw new Error(`Failed to fetch shop orders: ${shopError.message}`)
    }

    console.log(`Found ${shopOrdersData?.length || 0} shop orders`)

    // Fetch wallet payments to get Paystack references with pagination
    const { data: walletPayments, error: walletPaymentsError } = await supabase
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
      .range(0, 9999) // Paginate instead of unlimited

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

    // Combine all orders
    let allOrders = [...formattedBulkOrders, ...formattedShopOrders, ...formattedWalletPayments]

    // Apply search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase().trim()
      allOrders = allOrders.filter((order: any) => {
        if (searchType === "reference") {
          return order.payment_reference.toLowerCase().includes(query)
        } else if (searchType === "phone") {
          return order.phone_number.toLowerCase().includes(query)
        } else {
          // "all" - search both reference and phone
          return (
            order.payment_reference.toLowerCase().includes(query) ||
            order.phone_number.toLowerCase().includes(query)
          )
        }
      })
    }

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
