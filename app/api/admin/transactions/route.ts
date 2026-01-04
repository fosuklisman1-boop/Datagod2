import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    
    // Pagination
    const page = parseInt(searchParams.get("page") || "1")
    const limit = parseInt(searchParams.get("limit") || "50")
    const offset = (page - 1) * limit

    // Filters
    const search = searchParams.get("search") || ""
    const type = searchParams.get("type") || "" // credit, debit, refund, admin_credit, admin_debit
    const source = searchParams.get("source") || ""
    const status = searchParams.get("status") || ""
    const startDate = searchParams.get("startDate") || ""
    const endDate = searchParams.get("endDate") || ""
    const userId = searchParams.get("userId") || ""

    // Build query
    let query = supabase
      .from("transactions")
      .select(`
        *,
        users (
          id,
          email,
          first_name,
          last_name,
          phone_number
        )
      `, { count: "exact" })
      .order("created_at", { ascending: false })

    // Apply filters
    if (userId) {
      query = query.eq("user_id", userId)
    }

    if (type) {
      query = query.eq("type", type)
    }

    if (source) {
      query = query.eq("source", source)
    }

    if (status) {
      query = query.eq("status", status)
    }

    if (startDate) {
      query = query.gte("created_at", startDate)
    }

    if (endDate) {
      // Add 1 day to include the end date fully
      const endDateObj = new Date(endDate)
      endDateObj.setDate(endDateObj.getDate() + 1)
      query = query.lt("created_at", endDateObj.toISOString())
    }

    // Search by email, phone, name, reference_id, or description
    if (search) {
      // First try to find users matching the search
      const { data: matchingUsers } = await supabase
        .from("users")
        .select("id")
        .or(`email.ilike.%${search}%,phone_number.ilike.%${search}%,first_name.ilike.%${search}%,last_name.ilike.%${search}%`)

      const userIds = matchingUsers?.map(u => u.id) || []

      if (userIds.length > 0) {
        query = query.or(`reference_id.ilike.%${search}%,description.ilike.%${search}%,user_id.in.(${userIds.join(",")})`)
      } else {
        query = query.or(`reference_id.ilike.%${search}%,description.ilike.%${search}%`)
      }
    }

    // Apply pagination
    query = query.range(offset, offset + limit - 1)

    const { data: transactions, error, count } = await query

    if (error) {
      console.error("[ADMIN-TRANSACTIONS] Error fetching transactions:", error)
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      )
    }

    // Flatten user data for frontend
    const flattenedTransactions = transactions?.map(t => ({
      ...t,
      amount: t.amount ?? 0, // Ensure amount is never null
      user_email: t.users?.email || "Unknown",
      user_first_name: t.users?.first_name || null,
      user_last_name: t.users?.last_name || null,
      user_phone: t.users?.phone_number || null,
      users: undefined, // Remove nested object
    })) || []

    // Calculate stats
    const { data: statsData } = await supabase
      .from("transactions")
      .select("type, amount, status")

    let totalCredits = 0
    let totalDebits = 0
    let pendingCount = 0
    let failedCount = 0

    statsData?.forEach(t => {
      if (t.type === "credit" || t.type === "admin_credit" || t.type === "refund") {
        totalCredits += parseFloat(t.amount) || 0
      } else {
        totalDebits += parseFloat(t.amount) || 0
      }
      if (t.status === "pending") pendingCount++
      if (t.status === "failed") failedCount++
    })

    return NextResponse.json({
      transactions: flattenedTransactions,
      pagination: {
        page,
        limit,
        totalCount: count || 0,
        totalPages: Math.ceil((count || 0) / limit)
      },
      stats: {
        totalCredits,
        totalDebits,
        netFlow: totalCredits - totalDebits,
        pendingCount,
        failedCount,
        totalTransactions: statsData?.length || 0
      }
    })
  } catch (error) {
    console.error("[ADMIN-TRANSACTIONS] Error:", error)
    return NextResponse.json(
      { error: "Failed to load transactions. Please try again." },
      { status: 500 }
    )
  }
}
