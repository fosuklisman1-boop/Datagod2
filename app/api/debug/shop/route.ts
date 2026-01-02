import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createRouteHandlerClient } from "@supabase/auth-helpers-nextjs"
import { cookies } from "next/headers"

// Debug endpoint to check sub-agent shop data
export async function GET() {
  try {
    const supabase = createRouteHandlerClient({ cookies })
    
    // Get current user
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    
    if (authError || !user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
    }

    // Get user's shop with explicit column selection
    const { data: shop, error: shopError } = await supabase
      .from("user_shops")
      .select("*")
      .eq("user_id", user.id)
      .single()

    // Get user's role
    const { data: userData, error: userError } = await supabase
      .from("users")
      .select("role")
      .eq("id", user.id)
      .single()

    // If shop has parent_shop_id, get parent's packages
    let parentPackages = null
    let parentPackagesError = null
    let parentShop = null
    
    if (shop?.parent_shop_id) {
      // Get parent shop info
      const { data: pShop, error: pShopErr } = await supabase
        .from("user_shops")
        .select("*")
        .eq("id", shop.parent_shop_id)
        .single()
      parentShop = pShop
      
      // Get parent's packages
      const { data: pPkgs, error: pPkgsErr } = await supabase
        .from("shop_packages")
        .select(`
          package_id,
          profit_margin,
          is_available,
          package:packages (*)
        `)
        .eq("shop_id", shop.parent_shop_id)
        .eq("is_available", true)
      
      parentPackages = pPkgs
      parentPackagesError = pPkgsErr?.message
    }

    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        role_from_users_table: userData?.role || "NOT FOUND",
        role_from_metadata: user.user_metadata?.role || "NOT SET",
      },
      shop: {
        ...shop,
        _columns: shop ? Object.keys(shop) : []
      },
      shop_error: shopError?.message || null,
      has_parent_shop_id: !!shop?.parent_shop_id,
      parent_shop_id_value: shop?.parent_shop_id || "NOT SET / NULL",
      parent_shop: parentShop,
      parent_packages_count: parentPackages?.length || 0,
      parent_packages: parentPackages,
      parent_packages_error: parentPackagesError,
      diagnosis: !shop?.parent_shop_id 
        ? "❌ parent_shop_id is not set on this shop - either migration not run or shop was created before migration"
        : parentPackages?.length === 0
        ? "❌ Parent shop has no packages configured in shop_packages table"
        : parentPackages?.length > 0
        ? "✅ Everything looks correct - parent has packages"
        : "⚠️ Unknown issue"
    })
  } catch (error) {
    return NextResponse.json({ 
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined
    }, { status: 500 })
  }
}
