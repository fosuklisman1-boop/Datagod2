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

    // Get all users using admin API with pagination
    let allUsers: any[] = []
    let page = 1
    let hasMore = true

    while (hasMore) {
      const { data: pageUsers, error: usersError } = await adminClient.auth.admin.listUsers({
        perPage: 100,
        page: page,
      })

      if (usersError) {
        console.error("Error fetching users:", usersError)
        return NextResponse.json({ error: usersError.message }, { status: 400 })
      }

      const pageData = pageUsers?.users || []
      if (pageData.length === 0) {
        hasMore = false
      } else {
        allUsers = [...allUsers, ...pageData]
        page++
      }
    }

    const users = allUsers

    // Get shops info
    const { data: shops, error: shopsError } = await adminClient
      .from("user_shops")
      .select("id, user_id, shop_name, created_at")
      .order("created_at", { ascending: false })
      .range(0, 9999) // Paginate instead of unlimited

    if (shopsError) {
      console.error("Error fetching shops:", shopsError)
      return NextResponse.json({ error: shopsError.message }, { status: 400 })
    }

    // Get wallets info
    const { data: wallets, error: walletsError } = await adminClient
      .from("wallets")
      .select("user_id, balance")

    if (walletsError) {
      console.error("Error fetching wallets:", walletsError)
      return NextResponse.json({ error: walletsError.message }, { status: 400 })
    }

    // Get customer counts per shop
    const { data: customerCounts, error: customerError } = await adminClient
      .from("shop_customers")
      .select("shop_id, id")

    if (customerError) {
      console.error("Error fetching customer counts:", customerError)
      return NextResponse.json({ error: customerError.message }, { status: 400 })
    }

    // Group customer counts by shop_id
    const customerCountMap = new Map<string, number>()
    customerCounts?.forEach((record: any) => {
      const count = customerCountMap.get(record.shop_id) || 0
      customerCountMap.set(record.shop_id, count + 1)
    })

    // Get sub-agent counts per parent shop
    const { data: subAgentCounts, error: subAgentError } = await adminClient
      .from("user_shops")
      .select("parent_shop_id, id")
      .not("parent_shop_id", "is", null)

    if (subAgentError) {
      console.error("Error fetching sub-agent counts:", subAgentError)
      // Don't fail - just continue without sub-agent counts
    }

    // Group sub-agent counts by parent_shop_id
    const subAgentCountMap = new Map<string, number>()
    subAgentCounts?.forEach((record: any) => {
      const count = subAgentCountMap.get(record.parent_shop_id) || 0
      subAgentCountMap.set(record.parent_shop_id, count + 1)
    })

    // Get user profiles with phone numbers and roles
    const { data: userProfiles, error: profilesError } = await adminClient
      .from("users")
      .select("id, phone_number, role")

    if (profilesError) {
      console.error("Error fetching user profiles:", profilesError)
      return NextResponse.json({ error: profilesError.message }, { status: 400 })
    }

    // Combine user and shop data with balance from shop_available_balance table
    const usersWithInfo = await Promise.all(
      users.map(async (authUser: any) => {
        const shop = shops?.find((s: any) => s.user_id === authUser.id)
        const wallet = wallets?.find((w: any) => w.user_id === authUser.id)
        const profile = userProfiles?.find((p: any) => p.id === authUser.id)
        const walletBalance = wallet?.balance || 0
        const phoneNumber = profile?.phone_number || ""
        // Get role from metadata first, then fallback to database
        const role = authUser.user_metadata?.role || profile?.role || "user"

        if (!shop?.id) {
          return {
            id: authUser.id,
            email: authUser.email,
            phoneNumber: phoneNumber,
            created_at: authUser.created_at,
            shop: null,
            walletBalance: walletBalance,
            shopBalance: 0,
            balance: walletBalance, // For backwards compatibility
            role: role,
            customerCount: 0,
            subAgentCount: 0,
          }
        }

        // Get available balance from shop_available_balance table (same as shop dashboard)
        let { data: balanceData, error: balanceError } = await adminClient
          .from("shop_available_balance")
          .select("available_balance")
          .eq("shop_id", shop.id)
          .single()

        // If no balance record exists, create one with zero balance
        if (balanceError?.code === "PGRST116" || !balanceData) {
          const { data: newBalanceData, error: insertError } = await adminClient
            .from("shop_available_balance")
            .insert([{
              shop_id: shop.id,
              available_balance: 0,
              pending_profit: 0,
              credited_profit: 0,
              withdrawn_profit: 0,
              total_profit: 0
            }])
            .select("available_balance")
            .single()

          if (!insertError && newBalanceData) {
            balanceData = newBalanceData
          }
        }

        const shopBalance = balanceData?.available_balance || 0
        const customerCount = customerCountMap.get(shop.id) || 0
        const subAgentCount = subAgentCountMap.get(shop.id) || 0

        return {
          id: authUser.id,
          email: authUser.email,
          phoneNumber: phoneNumber,
          created_at: authUser.created_at,
          shop: shop,
          walletBalance: walletBalance,
          shopBalance: shopBalance,
          balance: walletBalance + shopBalance, // Total balance for backwards compatibility
          role: role,
          customerCount: customerCount,
          subAgentCount: subAgentCount,
        }
      })
    )

    return NextResponse.json(usersWithInfo)
  } catch (error: any) {
    console.error("API error:", error)
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 })
  }
}
