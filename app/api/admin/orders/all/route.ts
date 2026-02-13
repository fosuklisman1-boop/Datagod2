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
    const limit = parseInt(searchParams.get("limit") || "50")
    const offset = parseInt(searchParams.get("offset") || "0")

    console.log(`[ALL-ORDERS] Fetching orders. Search: "${searchQuery}" (type: ${searchType}), Limit: ${limit}, Offset: ${offset}`)

    // Use the unified view for high-performance pagination and search
    // Explicitly select columns to ensure consistency across view versions
    let query = supabase
      .from("combined_orders_view")
      .select(`
        id,
        created_at,
        phone_number,
        price,
        network,
        status,
        payment_status,
        payment_reference,
        volume_gb,
        type,
        customer_email,
        store_name,
        shop_owner_id,
        shop_owner_email
      `, { count: "exact" })

    const filterDate = searchParams.get("date")
    const filterNetwork = searchParams.get("network")
    const filterStatus = searchParams.get("status")
    const startTime = searchParams.get("startTime")
    const endTime = searchParams.get("endTime")

    if (filterDate) {
      let startStr = `${filterDate}T00:00:00Z`
      let endStr = `${filterDate}T23:59:59Z`

      if (startTime) {
        startStr = `${filterDate}T${startTime}:00Z`
      }
      if (endTime) {
        endStr = `${filterDate}T${endTime}:59Z`
      }

      query = query.gte("created_at", startStr)
      query = query.lte("created_at", endStr)
    }

    if (filterNetwork && filterNetwork !== "all" && filterNetwork !== "") {
      query = query.eq("network", filterNetwork)
    }

    if (filterStatus && filterStatus !== "all" && filterStatus !== "") {
      if (filterStatus.includes(",")) {
        const statusList = filterStatus.split(",").map(s => s.trim())
        query = query.in("status", statusList)
      } else {
        query = query.eq("status", filterStatus)
      }
    }

    query = query.order("created_at", { ascending: false })

    // Apply search filter to DB query if present
    if (searchQuery) {
      const q = searchQuery.trim()
      if (searchType === "phone") {
        query = query.ilike("phone_number", `%${q}%`)
      } else if (searchType === "reference") {
        query = query.ilike("payment_reference", `%${q}%`)
      } else {
        // all
        query = query.or(`phone_number.ilike.%${q}%,payment_reference.ilike.%${q}%,customer_email.ilike.%${q}%,store_name.ilike.%${q}%`)
      }
    }

    // Apply pagination
    const { data, error, count } = await query.range(offset, offset + limit - 1)

    if (error) {
      console.error("[ALL-ORDERS] Query Error:", error)
      throw error
    }

    const totalCount = count || 0
    const hasMore = offset + limit < totalCount

    console.log(`[ALL-ORDERS] Returning ${data?.length} orders from view. Total: ${totalCount}`)

    return NextResponse.json({
      success: true,
      data: data || [],
      count: totalCount,
      pagination: {
        total: totalCount,
        limit,
        offset,
        hasMore
      }
    })
  } catch (error) {
    console.error("Error in GET /api/admin/orders/all:", error)
    return NextResponse.json(
      { error: "Failed to load orders. Please try again." },
      { status: 500 }
    )
  }
}
