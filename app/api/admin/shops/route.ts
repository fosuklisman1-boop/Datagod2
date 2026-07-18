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
    const search = searchParams.get("search")?.trim()
    const limit = Math.min(Number(searchParams.get("limit") ?? 50), 1000)

    let query = supabase
      .from("user_shops")
      .select("id, shop_name, shop_slug, description, is_active, is_blocked, block_reason, created_at, user_id")

    if (status === "pending") {
      query = query.eq("is_active", false)
    } else if (status === "active") {
      query = query.eq("is_active", true)
    }

    if (search) {
      query = query.ilike("shop_name", `%${search}%`)
    }

    const { data, error } = await query.order("created_at", { ascending: false }).range(0, limit - 1)
    console.log("[ADMIN-SHOPS] Query executed, error:", error?.message || null, "data count:", data?.length || 0)

    if (error) {
      console.error("Error fetching shops:", error)
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      )
    }

    // Enrich with owner user details
    let enriched: any[] = data || []
    const userIds = [...new Set(enriched.map(s => s.user_id).filter(Boolean))]
    if (userIds.length > 0) {
      const { data: usersData } = await supabase
        .from("users")
        .select("id, email, phone_number, first_name, last_name")
        .in("id", userIds)

      if (usersData) {
        const usersMap = Object.fromEntries(usersData.map(u => [u.id, u]))
        enriched = enriched.map(shop => {
          const u = usersMap[shop.user_id]
          return {
            ...shop,
            owner_email: u?.email ?? null,
            owner_phone: u?.phone_number ?? null,
            owner_name: u ? [u.first_name, u.last_name].filter(Boolean).join(" ") || null : null,
          }
        })
      }
    }

    return NextResponse.json({
      success: true,
      data: enriched,
      count: enriched.length
    })
  } catch (error: any) {
    console.error("Error in GET /api/admin/shops:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
