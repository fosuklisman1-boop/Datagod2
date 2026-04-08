import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey)
    const { searchParams } = new URL(request.url)
    const status = searchParams.get("status")

    let query = supabase
      .from("user_shops")
      .select("id, shop_name, shop_slug, description, is_active, created_at, user_id")

    if (status === "pending") {
      console.log("[ADMIN-SHOPS] Filtering for pending shops (is_active=false)")
      query = query.eq("is_active", false)
    } else if (status === "active") {
      console.log("[ADMIN-SHOPS] Filtering for active shops (is_active=true)")
      query = query.eq("is_active", true)
    }

    const { data, error } = await query.order("created_at", { ascending: false }).range(0, 9999)
    console.log("[ADMIN-SHOPS] Query executed, error:", error?.message || null, "data count:", data?.length || 0)

    if (error) {
      console.error("Error fetching shops:", error)
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      data: data || [],
      count: data?.length || 0
    })
  } catch (error: any) {
    console.error("Error in GET /api/admin/shops:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
