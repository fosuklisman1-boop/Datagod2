import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

// Debug endpoint to check sub-agent shop data
// Usage: /api/debug/shop?user_id=xxx or with Bearer token
export async function GET(request: NextRequest) {
  try {
    let userId: string | null = null
    
    // Try to get user from Authorization header first
    const authHeader = request.headers.get("Authorization")
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7)
      const { data: { user }, error: authError } = await supabase.auth.getUser(token)
      if (!authError && user) {
        userId = user.id
      }
    }
    
    // Fallback: get user_id from query param (for easy debugging)
    if (!userId) {
      const url = new URL(request.url)
      userId = url.searchParams.get("user_id")
    }
    
    if (!userId) {
      return NextResponse.json({ 
        error: "No user found. Pass ?user_id=xxx or use Bearer token",
        hint: "Get user ID from Supabase Auth > Users" 
      }, { status: 400 })
    }

    // Get user info
    const { data: userData, error: userError } = await supabase
      .from("users")
      .select("*")
      .eq("id", userId)
      .single()

    // Get user's shop
    const { data: shop, error: shopError } = await supabase
      .from("user_shops")
      .select("*")
      .eq("user_id", userId)
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
        id: userId,
        email: userData?.email || "N/A",
        role: userData?.role || "NOT FOUND",
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
        : (parentPackages?.length ?? 0) === 0
        ? "❌ Parent shop has no packages configured in shop_packages table"
        : (parentPackages?.length ?? 0) > 0
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
