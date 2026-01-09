import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * GET /api/admin/blacklist
 * Fetch all blacklisted phone numbers
 */
export async function GET(request: NextRequest) {
  try {
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) {
      return errorResponse
    }

    const { searchParams } = new URL(request.url)
    const search = searchParams.get("search") || ""
    const limit = parseInt(searchParams.get("limit") || "50")
    const offset = parseInt(searchParams.get("offset") || "0")

    let query = supabase
      .from("blacklisted_phone_numbers")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1)

    if (search) {
      query = query.ilike("phone_number", `%${search}%`)
    }

    const { data, error, count } = await query

    if (error) {
      console.error("[BLACKLIST] Error fetching blacklist:", error)
      return NextResponse.json(
        { error: "Failed to fetch blacklist" },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      data: data || [],
      count: count || 0,
      pagination: {
        limit,
        offset,
        hasMore: (count || 0) > offset + limit,
      },
    })
  } catch (error) {
    console.error("[BLACKLIST] Error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}

/**
 * POST /api/admin/blacklist
 * Add single phone number to blacklist
 */
export async function POST(request: NextRequest) {
  try {
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) {
      return errorResponse
    }

    const body = await request.json()
    const { phone_number, reason } = body

    if (!phone_number) {
      return NextResponse.json(
        { error: "Phone number is required" },
        { status: 400 }
      )
    }

    const { data, error } = await supabase
      .from("blacklisted_phone_numbers")
      .insert([
        {
          phone_number,
          reason: reason || null,
          created_by: null, // Will be set by RLS if available
        },
      ])
      .select()

    if (error) {
      console.error("[BLACKLIST] Error adding to blacklist:", error)
      return NextResponse.json(
        { error: error.message || "Failed to add to blacklist" },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      message: `Added ${phone_number} to blacklist`,
      data: data?.[0],
    })
  } catch (error) {
    console.error("[BLACKLIST] Error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}

/**
 * DELETE /api/admin/blacklist?phone=...
 * Remove phone number from blacklist
 */
export async function DELETE(request: NextRequest) {
  try {
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) {
      return errorResponse
    }

    const { searchParams } = new URL(request.url)
    const phone = searchParams.get("phone")

    if (!phone) {
      return NextResponse.json(
        { error: "Phone number is required" },
        { status: 400 }
      )
    }

    const { error } = await supabase
      .from("blacklisted_phone_numbers")
      .delete()
      .eq("phone_number", phone)

    if (error) {
      console.error("[BLACKLIST] Error removing from blacklist:", error)
      return NextResponse.json(
        { error: "Failed to remove from blacklist" },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      message: `Removed ${phone} from blacklist`,
    })
  } catch (error) {
    console.error("[BLACKLIST] Error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
