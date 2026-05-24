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
    const phone = searchParams.get("phone")
    const page = parseInt(searchParams.get("page") || "1")
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 500)
    const offset = (page - 1) * limit

    // Per-status global counts for stat cards (always unfiltered by status)
    const [totalRes, successRes, failedRes, processingRes, pendingRes] = await Promise.all([
      supabase.from("fulfillment_logs").select("*", { count: "exact", head: true }),
      supabase.from("fulfillment_logs").select("*", { count: "exact", head: true }).eq("status", "success"),
      supabase.from("fulfillment_logs").select("*", { count: "exact", head: true }).eq("status", "failed"),
      supabase.from("fulfillment_logs").select("*", { count: "exact", head: true }).eq("status", "processing"),
      supabase.from("fulfillment_logs").select("*", { count: "exact", head: true }).eq("status", "pending"),
    ])

    const statusCounts = {
      total: totalRes.count ?? 0,
      success: successRes.count ?? 0,
      failed: failedRes.count ?? 0,
      processing: processingRes.count ?? 0,
      pending: pendingRes.count ?? 0,
    }

    // Filtered count for pagination
    let countQuery = supabase.from("fulfillment_logs").select("*", { count: "exact", head: true })
    if (status && status !== "all") countQuery = countQuery.eq("status", status)
    if (phone) countQuery = countQuery.ilike("phone_number", `%${phone}%`)
    const { count } = await countQuery

    // Fetch page of logs
    let query = supabase
      .from("fulfillment_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1)

    if (status && status !== "all") query = query.eq("status", status)
    if (phone) query = query.ilike("phone_number", `%${phone}%`)

    const { data: logs, error } = await query

    if (error) {
      console.error("[FULFILLMENT-LOGS] Error fetching logs:", error)
      return NextResponse.json({ error: "Failed to fetch fulfillment logs" }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      logs: logs || [],
      statusCounts,
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

/**
 * DELETE /api/admin/fulfillment/logs
 * Delete a fulfillment log by ID (mostly to clean up failed ones to stop cron fetches)
 */
export async function DELETE(request: NextRequest) {
  try {
    // Verify admin access
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) {
      return errorResponse
    }

    const { searchParams } = new URL(request.url)
    const id = searchParams.get("id")
    const bulk = searchParams.get("bulk")

    if (bulk === "failed") {
      const { error } = await supabase
        .from("fulfillment_logs")
        .delete()
        .eq("status", "failed")

      if (error) {
        console.error("[FULFILLMENT-LOGS] Error bulk deleting failed logs:", error)
        return NextResponse.json(
          { error: "Failed to bulk delete logs" },
          { status: 500 }
        )
      }

      return NextResponse.json({ success: true, message: "Bulk deleted successfully" })
    }

    if (!id) {
      return NextResponse.json(
        { error: "Log ID or bulk param is required" },
        { status: 400 }
      )
    }

    const { error } = await supabase
      .from("fulfillment_logs")
      .delete()
      .eq("id", id)

    if (error) {
      console.error("[FULFILLMENT-LOGS] Error deleting log:", error)
      return NextResponse.json(
        { error: "Failed to delete log" },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[FULFILLMENT-LOGS] Error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
