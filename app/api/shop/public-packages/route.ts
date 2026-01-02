import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// Force dynamic rendering
export const dynamic = "force-dynamic"

function getSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase environment variables")
  }
  
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

// GET: Get packages for a public shop storefront (by slug)
// This handles both regular shops (shop_packages) and sub-agents (sub_agent_catalog)
export async function GET(request: NextRequest) {
  try {
    const supabase = getSupabaseClient()

    const url = new URL(request.url)
    const shopSlug = url.searchParams.get("slug")

    if (!shopSlug) {
      return NextResponse.json({ error: "Shop slug required" }, { status: 400 })
    }

    // Get shop by slug
    const { data: shop, error: shopError } = await supabase
      .from("user_shops")
      .select("id, shop_name, parent_shop_id, is_active")
      .eq("shop_slug", shopSlug)
      .eq("is_active", true)
      .single()

    if (shopError || !shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    let packages: any[] = []

    // Check if this is a sub-agent (has parent_shop_id)
    if (shop.parent_shop_id) {
      // Sub-agent: get packages from sub_agent_catalog
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
        .eq("shop_id", shop.id)
        .eq("is_active", true)

      if (catalogError) {
        console.error("Error fetching sub-agent catalog:", catalogError)
        return NextResponse.json({ error: "Failed to fetch packages" }, { status: 500 })
      }

      // If sub-agent, also get parent's margins to calculate correct selling prices
      let parentMargins: Record<string, number> = {}
      if (shop.parent_shop_id) {
        const { data: parentCatalog } = await supabase
          .from("sub_agent_catalog")
          .select("package_id, wholesale_margin")
          .eq("shop_id", shop.parent_shop_id)
          .eq("is_active", true)

        if (parentCatalog && parentCatalog.length > 0) {
          parentMargins = (parentCatalog || []).reduce((acc: any, item: any) => {
            acc[item.package_id] = item.wholesale_margin
            return acc
          }, {})
        }
      }

      // Transform catalog items to match expected format
      // Sub-agent's selling price = parent's wholesale price (admin + parent margin) + sub-agent's margin
      packages = (catalogItems || [])
        .filter((item: any) => item.package?.active)
        .map((item: any) => {
          const adminPrice = item.package.price
          const parentMargin = parentMargins[item.package_id] || 0
          const parentWholesalePrice = adminPrice + parentMargin
          const sellingPrice = parentWholesalePrice + item.wholesale_margin
          
          return {
            id: item.id,
            package_id: item.package.id,
            profit_margin: item.wholesale_margin,
            is_available: item.is_active,
            packages: {
              id: item.package.id,
              network: item.package.network,
              size: item.package.size,
              price: adminPrice,
              description: item.package.description
            },
            // Calculated selling price: parent's wholesale price + sub-agent's margin
            selling_price: sellingPrice
          }
        })

    } else {
      // Regular shop owner: get packages from shop_packages
      const { data: shopPackages, error: pkgError } = await supabase
        .from("shop_packages")
        .select(`
          id,
          package_id,
          profit_margin,
          is_available,
          custom_name,
          packages (
            id,
            network,
            size,
            price,
            description,
            active
          )
        `)
        .eq("shop_id", shop.id)
        .eq("is_available", true)

      if (pkgError) {
        console.error("Error fetching shop packages:", pkgError)
        return NextResponse.json({ error: "Failed to fetch packages" }, { status: 500 })
      }

      // Filter out inactive admin packages
      packages = (shopPackages || [])
        .filter((item: any) => item.packages?.active !== false)
        .map((item: any) => ({
          ...item,
          selling_price: item.packages.price + item.profit_margin
        }))
    }

    return NextResponse.json({ 
      packages,
      is_sub_agent: !!shop.parent_shop_id
    })

  } catch (error) {
    console.error("Error in public-packages API:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch packages" },
      { status: 500 }
    )
  }
}
