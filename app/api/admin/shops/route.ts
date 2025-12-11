import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function GET(request: NextRequest) {
  try {
    // Verify user is authenticated and is an admin
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      // For API calls without auth, use service role with admin bypass
      const supabase = createClient(supabaseUrl, serviceRoleKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      })

      const { searchParams } = new URL(request.url)
      const status = searchParams.get("status") // "pending" or "active" or null for all

      let query = supabase
        .from("user_shops")
        .select("*")

      // Filter by status if specified
      if (status === "pending") {
        console.log("[ADMIN-SHOPS] Filtering for pending shops (is_active=false)")
        query = query.eq("is_active", false)
      } else if (status === "active") {
        console.log("[ADMIN-SHOPS] Filtering for active shops (is_active=true)")
        query = query.eq("is_active", true)
      }

      const { data, error } = await query.order("created_at", { ascending: false })
      console.log("[ADMIN-SHOPS] No auth - Query executed, error:", error?.message || null, "data count:", data?.length || 0)

      if (error) {
        console.error("Error fetching shops:", error)
        return NextResponse.json(
          { error: error.message },
          { status: 500, headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Cache-Control": "public, s-maxage=0, stale-while-revalidate=0"
          }}
        )
      }

      return NextResponse.json({
        success: true,
        data: data || [],
        count: data?.length || 0
      }, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Cache-Control": "public, s-maxage=0, stale-while-revalidate=0"
        }
      })
    }

    // Verify admin access
    const token = authHeader.slice(7)
    const supabaseClient = createClient(supabaseUrl, serviceRoleKey)
    const { data: { user: callerUser }, error: callerError } = await supabaseClient.auth.getUser(token)

    if (callerError || !callerUser) {
      return NextResponse.json({ error: "Unauthorized: Invalid token" }, { status: 401 })
    }

    // Check if caller is admin
    let isAdmin = callerUser.user_metadata?.role === "admin"
    if (!isAdmin) {
      const { data: userData } = await supabaseClient
        .from("users")
        .select("role")
        .eq("id", callerUser.id)
        .single()
      isAdmin = userData?.role === "admin"
    }

    if (!isAdmin) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 })
    }

    // Proceed with query
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })

    const { searchParams } = new URL(request.url)
    const status = searchParams.get("status")

    let query = supabase
      .from("user_shops")
      .select("*")

    if (status === "pending") {
      console.log("[ADMIN-SHOPS] Filtering for pending shops (is_active=false)")
      query = query.eq("is_active", false)
    } else if (status === "active") {
      console.log("[ADMIN-SHOPS] Filtering for active shops (is_active=true)")
      query = query.eq("is_active", true)
    }

    const { data, error } = await query.order("created_at", { ascending: false })
    console.log("[ADMIN-SHOPS] With auth - Query executed, error:", error?.message || null, "data count:", data?.length || 0)

    if (error) {
      console.error("Error fetching shops:", error)
      return NextResponse.json(
        { error: error.message },
        { status: 500, headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Cache-Control": "public, s-maxage=0, stale-while-revalidate=0"
        }}
      )
    }

    return NextResponse.json({
      success: true,
      data: data || [],
      count: data?.length || 0
    }, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Cache-Control": "public, s-maxage=0, stale-while-revalidate=0"
      }
    })
  } catch (error: any) {
    console.error("Error in GET /api/admin/shops:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500, headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Cache-Control": "public, s-maxage=0, stale-while-revalidate=0"
      }}
    )
  }
}

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json(
    {},
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Cache-Control": "public, s-maxage=0, stale-while-revalidate=0"
      }
    }
  )
}
