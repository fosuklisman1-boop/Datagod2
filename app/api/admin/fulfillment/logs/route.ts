import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * GET /api/admin/fulfillment/logs
 * Fetch all fulfillment logs (bypasses RLS)
 */
export async function GET(request: NextRequest) {
  try {
    // Verify admin access
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) {
      return errorResponse
    }

    const { searchParams } = new URL(request.url)
    const status = searchParams.get("status")
    const page = parseInt(searchParams.get("page") || "1")
    const limit = Math.min(parseInt(searchParams.get("limit") || "100"), 500) // Max 500 per page
    const offset = (page - 1) * limit

    // Get total count
    let countQuery = supabase
      .from("fulfillment_logs")
      .select("*", { count: "exact", head: true })

    if (status && status !== "all") {
      countQuery = countQuery.eq("status", status)
    }

    const { count } = await countQuery

    // Fetch fulfillment logs with pagination
    let query = supabase
      .from("fulfillment_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1)

    if (status && status !== "all") {
      query = query.eq("status", status)
    }

    const { data: logs, error } = await query

    if (error) {
      console.error("[FULFILLMENT-LOGS] Error fetching logs:", error)
      return NextResponse.json(
        { error: "Failed to fetch fulfillment logs" },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      logs: logs || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
      },
    })
  } catch (error) {
    console.error("[FULFILLMENT-LOGS] Error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
