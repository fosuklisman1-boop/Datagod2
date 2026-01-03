import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

// GET: Get packages available for a sub-agent (from their parent's sub_agent_catalog)
export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Get user's shop
    const { data: shop, error: shopError } = await supabase
      .from("user_shops")
      .select("id, parent_shop_id, tier_level")
      .eq("user_id", user.id)
      .single()

    if (shopError || !shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    // If no parent shop, return empty (not a sub-agent)
    if (!shop.parent_shop_id) {
      return NextResponse.json({ 
        is_sub_agent: false,
        packages: [] 
      })
    }

    // Get parent's sub-agent catalog
    const { data: catalogItems, error: catalogError } = await supabase
      .from("sub_agent_catalog")
      .select(`
        id,
        package_id,
        wholesale_margin,
        is_active,
        package:packages (
          id,
          network,
          size,
          price,
          description,
          active
        )
      `)
      .eq("shop_id", shop.parent_shop_id)
      .eq("is_active", true)

    if (catalogError) {
      console.error("Error fetching parent catalog:", catalogError)
      return NextResponse.json({ error: "Failed to fetch packages" }, { status: 500 })
    }

    // Transform packages: sub-agent's wholesale price = admin price + parent's margin
    const transformedPackages = (catalogItems || [])
      .filter((item: any) => item.package?.active)
      .map((item: any) => ({
        id: item.package.id,
        network: item.package.network,
        size: item.package.size,
        // Parent's selling price = admin price + parent's margin
        parent_price: item.package.price + item.wholesale_margin,
        description: item.package.description,
        active: item.package.active,
        // Include profit_margin for display in my-shop
        profit_margin: item.wholesale_margin,
        _parent_wholesale_margin: item.wholesale_margin,
        _original_admin_price: item.package.price
      }))

    return NextResponse.json({
      is_sub_agent: true,
      parent_shop_id: shop.parent_shop_id,
      packages: transformedPackages
    })

  } catch (error) {
    console.error("Error in parent-packages API:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch packages" },
      { status: 500 }
    )
  }
}
