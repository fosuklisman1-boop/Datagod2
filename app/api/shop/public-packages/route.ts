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
      // Sub-agent: get packages from sub_agent_shop_packages table (their own inventory)
      // Fall back to sub_agent_catalog for backwards compatibility
      const { data: shopPkgs, error: shopPkgsError } = await supabase
        .from("sub_agent_shop_packages")
        .select(`
          id,
          package_id,
          parent_price,
          sub_agent_profit_margin,
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

      if (shopPkgsError && shopPkgsError.code !== 'PGRST116') {
        // If not "relation does not exist", it's a real error
        console.error("Error fetching sub-agent shop packages:", shopPkgsError)
        return NextResponse.json({ error: "Failed to fetch packages" }, { status: 500 })
      }

      // If sub_agent_shop_packages table exists and has data, use it
      if (!shopPkgsError && shopPkgs && shopPkgs.length > 0) {
        // Transform catalog items using stored parent_price
        packages = shopPkgs
          .filter((item: any) => item.package?.active)
          .map((item: any) => {
            const parentPrice = item.parent_price !== undefined && item.parent_price !== null
              ? Number(item.parent_price)
              : item.package.price;
            const subAgentMargin = item.sub_agent_profit_margin !== undefined && item.sub_agent_profit_margin !== null
              ? Number(item.sub_agent_profit_margin)
              : 0;
            const sellingPrice = parentPrice + subAgentMargin;
            
            return {
              id: item.id,
              package_id: item.package.id,
              profit_margin: subAgentMargin,
              parent_price: parentPrice,
              is_available: item.is_active,
              packages: {
                id: item.package.id,
                network: item.package.network,
                size: item.package.size,
                price: parentPrice,
                description: item.package.description
              },
              selling_price: sellingPrice
            }
          })
      } else {
        // Fall back to sub_agent_catalog for backwards compatibility
        const { data: catalogItems, error: catalogError } = await supabase
          .from("sub_agent_catalog")
          .select(`
            id,
            package_id,
            parent_price,
            sub_agent_profit_margin,
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

        // Transform using stored parent_price
        packages = (catalogItems || [])
          .filter((item: any) => item.package?.active)
          .map((item: any) => {
            const parentPrice = item.parent_price !== undefined && item.parent_price !== null
              ? Number(item.parent_price)
              : item.package.price;
            const subAgentMargin = item.sub_agent_profit_margin !== undefined && item.sub_agent_profit_margin !== null
              ? Number(item.sub_agent_profit_margin)
              : (item.wholesale_margin || 0);
            const sellingPrice = parentPrice + subAgentMargin;
            
            return {
              id: item.id,
              package_id: item.package.id,
              profit_margin: subAgentMargin,
              parent_price: parentPrice,
              is_available: item.is_active,
              packages: {
                id: item.package.id,
                network: item.package.network,
                size: item.package.size,
                price: parentPrice,
                description: item.package.description
              },
              selling_price: sellingPrice
            }
          })
      }

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
      { error: "Failed to load packages. Please try again." },
      { status: 500 }
    )
  }
}
