import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function GET(req: NextRequest) {
  try {
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

    // Combine user and shop data with balance calculation
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

        // Get profits for balance calculation
        const { data: profits } = await adminClient
          .from("shop_profits")
          .select("profit_amount, status")
          .eq("shop_id", shop.id)

        const balance = profits?.reduce((sum: number, p: any) => {
          return p.status === "pending" ? sum + p.profit_amount : sum
        }, 0) || 0

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
