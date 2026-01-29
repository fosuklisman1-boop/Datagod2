import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Cleanup threshold: Mark pending attempts older than this as abandoned (in minutes)
const ABANDONED_THRESHOLD_MINUTES = 10

interface PaymentAttemptRecord {
  id: string
  user_id: string
  reference: string
  amount: number | null
  fee: number | null
  email: string | null
  status: string
  payment_type: string
  shop_id: string | null
  order_id: string | null
  gateway_response: string | null
  paystack_transaction_id: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

/**
 * Automatically mark stale pending payment attempts as abandoned
 * Runs on each GET request (non-blocking)
 */
async function cleanupAbandonedAttempts() {
  try {
    const cutoffTime = new Date(Date.now() - ABANDONED_THRESHOLD_MINUTES * 60 * 1000).toISOString()
    
    const { data, error } = await supabase
      .from("payment_attempts")
      .update({
        status: "abandoned",
        gateway_response: `Auto-marked as abandoned after ${ABANDONED_THRESHOLD_MINUTES} minutes`,
        updated_at: new Date().toISOString(),
      })
      .eq("status", "pending")
      .lt("created_at", cutoffTime)
      .select("id")

    if (error) {
      console.warn("[PAYMENT-ATTEMPTS] Cleanup error:", error.message)
    } else if (data && data.length > 0) {
      console.log(`[PAYMENT-ATTEMPTS] ✓ Marked ${data.length} stale attempts as abandoned`)
    }
  } catch (err) {
    console.warn("[PAYMENT-ATTEMPTS] Cleanup failed:", err)
  }
}

export async function GET(request: NextRequest) {
  try {
    // Run cleanup in background (non-blocking)
    cleanupAbandonedAttempts()

    const { searchParams } = new URL(request.url)
    
    // Pagination
    const page = parseInt(searchParams.get("page") || "1")
    const limit = parseInt(searchParams.get("limit") || "50")
    const offset = (page - 1) * limit

    // Filters
    const search = searchParams.get("search") || ""
    const status = searchParams.get("status") || ""
    const paymentType = searchParams.get("paymentType") || ""
    const startDate = searchParams.get("startDate") || ""
    const endDate = searchParams.get("endDate") || ""

    // Build query - no join to users since payment_attempts stores email directly
    let query = supabase
      .from("payment_attempts")
      .select(`*`, { count: "exact" })
      .order("created_at", { ascending: false })

    // Apply filters
    if (status) {
      query = query.eq("status", status)
    }

    if (paymentType) {
      query = query.eq("payment_type", paymentType)
    }

    if (startDate) {
      query = query.gte("created_at", startDate)
    }

    if (endDate) {
      const endDateObj = new Date(endDate)
      endDateObj.setDate(endDateObj.getDate() + 1)
      query = query.lt("created_at", endDateObj.toISOString())
    }

    // Search by email or reference
    if (search) {
      query = query.or(`reference.ilike.%${search}%,email.ilike.%${search}%`)
    }

    // Apply pagination
    query = query.range(offset, offset + limit - 1)

    const { data: attempts, error, count } = await query

    if (error) {
      console.error("[ADMIN-PAYMENT-ATTEMPTS] Error fetching payment attempts:", error)
      return NextResponse.json({ error: error.message }, { status: 400 })
    }

    // Format data - email is stored directly in payment_attempts
    const flattenedAttempts = (attempts as PaymentAttemptRecord[] | null)?.map((a: PaymentAttemptRecord) => ({
      ...a,
      amount: a.amount ?? 0,
      fee: a.fee ?? 0,
      user_email: a.email || "Unknown",
    })) || []

    // Calculate stats - use RPC or multiple count queries to avoid 1000 row limit
    const stats = {
      total: count || 0,
      pending: 0,
      completed: 0,
      failed: 0,
      abandoned: 0,
      totalAmount: 0,
      completedAmount: 0,
      walletTopups: 0,
      shopOrders: 0,
    }

    // Get status counts without 1000 limit
    const { count: pendingCount } = await supabase
      .from("payment_attempts")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")

    const { count: completedCount } = await supabase
      .from("payment_attempts")
      .select("id", { count: "exact", head: true })
      .eq("status", "completed")

    const { count: failedCount } = await supabase
      .from("payment_attempts")
      .select("id", { count: "exact", head: true })
      .eq("status", "failed")

    const { count: abandonedCount } = await supabase
      .from("payment_attempts")
      .select("id", { count: "exact", head: true })
      .eq("status", "abandoned")

    const { count: walletCount } = await supabase
      .from("payment_attempts")
      .select("id", { count: "exact", head: true })
      .eq("payment_type", "wallet_topup")

    const { count: shopCount } = await supabase
      .from("payment_attempts")
      .select("id", { count: "exact", head: true })
      .eq("payment_type", "shop_order")

    // Get sum totals - paginate to avoid 1000 row limit
    let allAmountData: any[] = []
    let amountOffset = 0
    const amountLimit = 1000
    let hasMoreAmounts = true
    
    while (hasMoreAmounts) {
      const { data: batchData } = await supabase
        .from("payment_attempts")
        .select("amount, status")
        .range(amountOffset, amountOffset + amountLimit - 1)
      
      if (batchData && batchData.length > 0) {
        allAmountData = allAmountData.concat(batchData)
        amountOffset += amountLimit
        hasMoreAmounts = batchData.length === amountLimit
      } else {
        hasMoreAmounts = false
      }
    }

    stats.pending = pendingCount || 0
    stats.completed = completedCount || 0
    stats.failed = failedCount || 0
    stats.abandoned = abandonedCount || 0
    stats.walletTopups = walletCount || 0
    stats.shopOrders = shopCount || 0

    allAmountData.forEach((a: { amount: number | null; status: string }) => {
      const amount = parseFloat(String(a.amount)) || 0
      stats.totalAmount += amount
      if (a.status === "completed") {
        stats.completedAmount += amount
      }
    })

    return NextResponse.json({
      attempts: flattenedAttempts,
      pagination: {
        page,
        limit,
        totalCount: count || 0,
        totalPages: Math.ceil((count || 0) / limit)
      },
      stats
    })
  } catch (error) {
    console.error("[ADMIN-PAYMENT-ATTEMPTS] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
