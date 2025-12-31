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

    // Calculate stats
    const { data: allAttempts } = await supabase
      .from("payment_attempts")
      .select("status, amount, payment_type")

    interface StatsRecord {
      status: string
      amount: number | string | null
      payment_type: string
    }

    const stats = {
      total: allAttempts?.length || 0,
      pending: 0,
      completed: 0,
      failed: 0,
      abandoned: 0,
      totalAmount: 0,
      completedAmount: 0,
      walletTopups: 0,
      shopOrders: 0,
    }

    ;(allAttempts as StatsRecord[] | null)?.forEach((a: StatsRecord) => {
      const amount = parseFloat(String(a.amount)) || 0
      stats.totalAmount += amount
      
      if (a.status === "pending") stats.pending++
      else if (a.status === "completed") {
        stats.completed++
        stats.completedAmount += amount
      }
      else if (a.status === "failed") stats.failed++
      else if (a.status === "abandoned") stats.abandoned++

      if (a.payment_type === "wallet_topup") stats.walletTopups++
      else if (a.payment_type === "shop_order") stats.shopOrders++
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
