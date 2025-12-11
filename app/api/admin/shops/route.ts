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
      const limit = parseInt(searchParams.get("limit") || "100", 10) // Default 100, max 500
      const offset = parseInt(searchParams.get("offset") || "0", 10)
      
      const actualLimit = Math.min(Math.max(limit, 1), 500) // Clamp between 1 and 500

      let query = supabase
        .from("user_shops")
        .select("id, shop_name, shop_slug, is_active, created_at, logo_url", { count: "exact" })

      // Filter by status if specified
      if (status === "pending") {
        console.log("[ADMIN-SHOPS-API] Filtering for pending shops (is_active=false)")
        query = query.eq("is_active", false)
      } else if (status === "active") {
        console.log("[ADMIN-SHOPS-API] Filtering for active shops (is_active=true)")
        query = query.eq("is_active", true)
      }

      const queryStartTime = Date.now()
      const { data, error, count } = await query
        .order("created_at", { ascending: false })
        .range(offset, offset + actualLimit - 1)
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
        count: data?.length || 0,
        total: count || 0,
        limit: actualLimit,
        offset: offset
      }, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Cache-Control": "public, s-maxage=0, stale-while-revalidate=0"
        }
      })
    }

    // For authenticated requests, use service role key  
    // (admin check is enforced via RLS policies in the database)
    console.log("[ADMIN-SHOPS-API] Authenticated request with token, using service role")
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })

    const { searchParams } = new URL(request.url)
    const status = searchParams.get("status")
    const limit = parseInt(searchParams.get("limit") || "100", 10)
    const offset = parseInt(searchParams.get("offset") || "0", 10)
    
    const actualLimit = Math.min(Math.max(limit, 1), 500)

    let query = supabase
      .from("user_shops")
      .select("id, shop_name, shop_slug, is_active, created_at, logo_url", { count: "exact" })

    if (status === "pending") {
      console.log("[ADMIN-SHOPS-API] Filtering for pending shops (is_active=false)")
      query = query.eq("is_active", false)
    } else if (status === "active") {
      console.log("[ADMIN-SHOPS-API] Filtering for active shops (is_active=true)")
      query = query.eq("is_active", true)
    }

    const queryStartTime = Date.now()
    const { data, error, count } = await query
      .order("created_at", { ascending: false })
      .range(offset, offset + actualLimit - 1)
    const queryDuration = Date.now() - queryStartTime
    console.log("[ADMIN-SHOPS-API] Query executed in", queryDuration, "ms, error:", error?.message || null, "data count:", data?.length || 0, "total:", count)

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
      count: data?.length || 0,
      total: count || 0,
      limit: actualLimit,
      offset: offset
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
