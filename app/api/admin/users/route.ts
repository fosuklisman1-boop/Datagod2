import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function GET(req: NextRequest) {
  try {
    // Verify user is authenticated and is an admin
    const authHeader = req.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized: Missing auth token" }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const supabaseClient = createClient(supabaseUrl, serviceRoleKey)
    const { data: { user: callerUser }, error: callerError } = await supabaseClient.auth.getUser(token)

    if (callerError || !callerUser) {
      return NextResponse.json({ error: "Unauthorized: Invalid token" }, { status: 401 })
    }

    // Check if caller is admin - check both user_metadata and the users table
    let isAdmin = callerUser.user_metadata?.role === "admin"
    
    if (!isAdmin) {
      // Also check the users table as a fallback
      const { data: userData, error: userError } = await supabaseClient
        .from("users")
        .select("role")
        .eq("id", callerUser.id)
        .single()
      
      if (!userError && userData?.role === "admin") {
        isAdmin = true
      }
    }

    if (!isAdmin) {
      console.warn(`[USERS] Unauthorized attempt by user ${callerUser.id}. Not an admin.`)
      return NextResponse.json({ error: "Admin access required" }, { status: 403 })
    }

    // Create admin client with service role
    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })

    // Get all users using admin API
    const { data: allUsers, error: usersError } = await adminClient.auth.admin.listUsers()

    if (usersError) {
      console.error("Error fetching users:", usersError)
      return NextResponse.json({ error: usersError.message }, { status: 400 })
    }

    const users = allUsers?.users || []

    // Get shops info
    const { data: shops, error: shopsError } = await adminClient
      .from("user_shops")
      .select("id, user_id, shop_name, created_at")
      .order("created_at", { ascending: false })

    if (shopsError) {
      console.error("Error fetching shops:", shopsError)
      return NextResponse.json({ error: shopsError.message }, { status: 400 })
    }

    // Combine user and shop data with balance from shop_available_balance table
    const usersWithInfo = await Promise.all(
      users.map(async (authUser: any) => {
        const shop = shops?.find((s: any) => s.user_id === authUser.id)

        if (!shop?.id) {
          return {
            id: authUser.id,
            email: authUser.email,
            created_at: authUser.created_at,
            shop: null,
            balance: 0,
            role: authUser.user_metadata?.role || "user",
          }
        }

        // Get available balance from shop_available_balance table (same as shop dashboard)
        const { data: balanceData } = await adminClient
          .from("shop_available_balance")
          .select("available_balance")
          .eq("shop_id", shop.id)
          .single()

        const balance = balanceData?.available_balance || 0

        return {
          id: authUser.id,
          email: authUser.email,
          created_at: authUser.created_at,
          shop: shop,
          balance: balance,
          role: authUser.user_metadata?.role || "user",
        }
      })
    )

    return NextResponse.json(usersWithInfo)
  } catch (error: any) {
    console.error("API error:", error)
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 })
  }
}
