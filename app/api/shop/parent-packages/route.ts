import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { CustomPriceReadError, NO_CUSTOM_PRICES } from "@/lib/pricing/package-price"
import { priceWith } from "@/lib/roles/pricing"
import { ownerBasePrices, shopOwnerSlug } from "@/lib/shop-commerce/pricing"

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
          dealer_price,
          description,
          is_available
        )
      `)
      .eq("shop_id", shop.parent_shop_id)
      .eq("is_active", true)

    if (catalogError) {
      console.error("Error fetching parent catalog:", catalogError)
      return NextResponse.json({ error: "Failed to fetch packages" }, { status: 500 })
    }

    // The parent's base price comes from the role resolver (admin priced as a dealer). Display only: custom prices
    // never change what a sub-agent pays, so only the owner's ladder slug is read.
    const available = (catalogItems || []).filter((item: any) => item.package?.is_available)
    let base: Map<string, number>
    try {
      const slug = await shopOwnerSlug(shop.parent_shop_id, supabase as Parameters<typeof shopOwnerSlug>[1])
      base = await ownerBasePrices(
        supabase as Parameters<typeof ownerBasePrices>[0],
        { slug, custom: NO_CUSTOM_PRICES },
        available.map((item: any) => item.package)
      )
    } catch (e) {
      if (!(e instanceof CustomPriceReadError)) throw e
      console.error("[PARENT-PACKAGES] parent prices unavailable:", e.name)
      return NextResponse.json({ error: "Failed to load prices" }, { status: 503 })
    }

    // Transform packages: sub-agent's wholesale price = parent's base price + parent's margin
    const transformedPackages = available
      .map((item: any) => {
        const adminPrice = priceWith(base, item.package, NO_CUSTOM_PRICES)

        const parentMargin = item.wholesale_margin
        const parentSellingPrice = adminPrice + parentMargin

        return {
          // IMPORTANT: id must be sub_agent_catalog.id for order creation validation
          id: item.id,
          // Also include package_id for reference
          package_id: item.package.id,
          network: item.package.network,
          size: item.package.size,
          // parent_price: what the parent sells to sub-agent (admin price + parent's margin)
          parent_price: parentSellingPrice,
          // base_price: the parent's own base price, before their margin
          base_price: adminPrice,
          description: item.package.description,
          active: item.package.is_available,
          // profit_margin: parent's margin (for reference, but not used for calculating sub-agent profit)
          profit_margin: parentMargin,
          _parent_wholesale_margin: parentMargin,
          _original_admin_price: adminPrice,
          _parent_selling_price: parentSellingPrice
        }
      })

    return NextResponse.json({
      is_sub_agent: true,
      parent_shop_id: shop.parent_shop_id,
      packages: transformedPackages
    })

  } catch (error) {
    console.error("Error in parent-packages API:", error)
    return NextResponse.json(
      { error: "Failed to load packages. Please try again." },
      { status: 500 }
    )
  }
}
