import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function GET(request: NextRequest) {
  const startTime = Date.now()
  try {
    console.log("[ADMIN-SHOPS-API] GET request received at", new Date().toISOString())
    
    // Verify user is authenticated and is an admin
    const authHeader = request.headers.get("Authorization")
    console.log("[ADMIN-SHOPS-API] Authorization header present:", !!authHeader)
    
    if (!authHeader?.startsWith("Bearer ")) {
      console.log("[ADMIN-SHOPS-API] No auth header, using service role")
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
        console.log("[ADMIN-SHOPS-API] Filtering for pending shops (is_active=false)")
        query = query.eq("is_active", false)
      } else if (status === "active") {
        console.log("[ADMIN-SHOPS-API] Filtering for active shops (is_active=true)")
        query = query.eq("is_active", true)
      }

      const queryStartTime = Date.now()
      const { data, error } = await query.order("created_at", { ascending: false })
      const queryDuration = Date.now() - queryStartTime
      console.log("[ADMIN-SHOPS-API] Query executed in", queryDuration, "ms, error:", error?.message || null, "data count:", data?.length || 0)

      if (error) {
        console.error("[ADMIN-SHOPS-API] Error fetching shops:", error)
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

      const totalDuration = Date.now() - startTime
      console.log("[ADMIN-SHOPS-API] Total response time:", totalDuration, "ms")
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
    console.log("[ADMIN-SHOPS-API] Verifying admin access with token")
    const token = authHeader.slice(7)
    const supabaseClient = createClient(supabaseUrl, serviceRoleKey)
    const { data: { user: callerUser }, error: callerError } = await supabaseClient.auth.getUser(token)

    if (callerError || !callerUser) {
      console.error("[ADMIN-SHOPS-API] Invalid token:", callerError?.message)
      return NextResponse.json({ error: "Unauthorized: Invalid token" }, { status: 401 })
    }

    // Check if caller is admin
    console.log("[ADMIN-SHOPS-API] Checking admin status for user:", callerUser.id)
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
      console.log("[ADMIN-SHOPS-API] Filtering for pending shops (is_active=false)")
      query = query.eq("is_active", false)
    } else if (status === "active") {
      console.log("[ADMIN-SHOPS-API] Filtering for active shops (is_active=true)")
      query = query.eq("is_active", true)
    }

    const queryStartTime = Date.now()
    const { data, error } = await query.order("created_at", { ascending: false })
    const queryDuration = Date.now() - queryStartTime
    console.log("[ADMIN-SHOPS-API] With auth - Query executed in", queryDuration, "ms, error:", error?.message || null, "data count:", data?.length || 0)

    if (error) {
      console.error("[ADMIN-SHOPS-API] Error fetching shops:", error)
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

    const totalDuration = Date.now() - startTime
    console.log("[ADMIN-SHOPS-API] Returning shops successfully, count:", data?.length || 0, "total time:", totalDuration, "ms")
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
    console.error("[ADMIN-SHOPS-API] Error in GET /api/admin/shops:", error)
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
  console.log("[ADMIN-SHOPS-API] OPTIONS request received")
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
