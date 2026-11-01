import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { CustomPriceReadError } from "@/lib/pricing/package-price"
import { subAgentCosts, type SubAgentOffer } from "@/lib/shop-commerce/pricing"

// Force dynamic rendering - env vars read at runtime, not build time
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

// GET: Get shop owner's sub-agent catalog
export async function GET(request: NextRequest) {
  try {
    const supabase = getSupabaseClient()

    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Get shop with parent info
    const { data: shop, error: shopError } = await supabase
      .from("user_shops")
      .select("id, parent_shop_id")
      .eq("user_id", user.id)
      .single()

    if (shopError || !shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    // If this is a sub-agent, they should use sub_agent_shop_packages table
    // If this is a parent, they use sub_agent_catalog table
    const tableName = shop.parent_shop_id ? "sub_agent_shop_packages" : "sub_agent_catalog"

    console.log("=== SUB-AGENT-CATALOG GET ===")
    console.log("Shop ID:", shop.id)
    console.log("Parent Shop ID:", shop.parent_shop_id)
    console.log("Table Name:", tableName)

    // Build select query based on table type
    // sub_agent_shop_packages has: parent_price, sub_agent_profit_margin
    // sub_agent_catalog has: wholesale_margin
    const selectFields = tableName === "sub_agent_shop_packages"
      ? `id, package_id, parent_price, sub_agent_profit_margin, is_active, created_at, package:packages (id, network, size, price, dealer_price, description, is_available)`
      : `id, package_id, wholesale_margin, is_active, created_at, package:packages (id, network, size, price, dealer_price, description, is_available)`

    // Get catalog items with package details
    let { data: catalog, error: catalogError } = await supabase
      .from(tableName)
      .select(selectFields)
      .eq("shop_id", shop.id)
      .order("created_at", { ascending: false }) as { data: any; error: any }

    console.log("First query error:", catalogError?.message)
    console.log("First query result count:", catalog?.length || 0)

    // For sub-agents, if sub_agent_shop_packages table fails or is empty, fallback to sub_agent_catalog
    if (shop.parent_shop_id && (catalogError || !catalog || catalog.length === 0)) {
      console.log("Falling back to sub_agent_catalog for sub-agent")
      const { data: fallbackCatalog, error: fallbackError } = await supabase
        .from("sub_agent_catalog")
        .select(`id, package_id, wholesale_margin, is_active, created_at, package:packages (id, network, size, price, dealer_price, description, is_available)`)
        .eq("shop_id", shop.id)
        .order("created_at", { ascending: false }) as { data: any; error: any }

      console.log("Fallback error:", fallbackError?.message)
      console.log("Fallback result count:", fallbackCatalog?.length || 0)

      if (!fallbackError && fallbackCatalog) {
        catalog = fallbackCatalog
        catalogError = null
      } else {
        catalogError = fallbackError || catalogError
      }
    }

    if (catalogError) {
      console.error("Error fetching catalog:", catalogError)
      console.error("Error details:", {
        code: catalogError.code,
        message: catalogError.message,
        details: catalogError.details
      })
      return NextResponse.json({ error: "Failed to fetch catalog", details: catalogError.message }, { status: 500 })
    }

    // Sub-agent: only what the parent offers right now, at the parent's LIVE cost (subAgentCosts: the parent's role
    // price + the parent's active wholesale margin), as the storefront and the order route price it. A row for a
    // package the parent no longer offers is left out (shop-pricing lists only parent-packages, which hides it too,
    // and POST/PUT update an existing row by package, so nothing is duplicated if the parent offers it again).
    if (shop.parent_shop_id) {
      let offers
      try {
        offers = await subAgentCosts(
          shop.parent_shop_id,
          (catalog || []).map((item: any) => String(item.package_id)),
          supabase as Parameters<typeof subAgentCosts>[2]
        )
      } catch (e) {
        if (!(e instanceof CustomPriceReadError)) throw e
        console.error("Error reading the parent's catalog or pricing for sub-agent shop", shop.id)
        return NextResponse.json({ error: "Failed to fetch catalog" }, { status: 500 })
      }

      const subAgentCatalog = (catalog || [])
        .map((item: any) => ({ item, offer: offers.costs.get(String(item.package_id)) }))
        .filter(({ offer }: { offer: SubAgentOffer | null | undefined }) => !!offer)
        .map(({ item, offer }: { item: any; offer: SubAgentOffer }) => {
          // Use sub_agent_profit_margin if available, fallback to wholesale_margin for backwards compatibility
          const subAgentMargin = item.sub_agent_profit_margin !== undefined && item.sub_agent_profit_margin !== null
            ? Number(item.sub_agent_profit_margin)
            : Number(item.wholesale_margin || 0)
          return {
            ...item,
            is_active: item.is_active !== undefined ? item.is_active : true,
            // parent_price: what this sub-agent pays the parent, live (the stored column is not trusted)
            parent_price: offer.cost,
            // selling_price: what this sub-agent's customers pay
            selling_price: Math.round((offer.cost + subAgentMargin) * 100) / 100,
            // profit_margin: the sub-agent's own margin
            profit_margin: subAgentMargin,
            is_dealer: offers.parent.isDealer,
          }
        })

      return NextResponse.json({ catalog: subAgentCatalog, is_dealer: offers.parent.isDealer })
    }

    // Parent (no parent_shop_id): their own catalog, shown at their role price + their wholesale margin.
    const { data: userData } = await supabase
      .from("users")
      .select("role")
      .eq("id", user.id)
      .single();
    const isDealer = userData?.role === 'dealer' || userData?.role === 'admin';

    // Transform to include calculated prices
    const catalogWithPrices = (catalog || []).map((item: any) => {
      // Use dealer_price if dealer, otherwise use packages.price
      const pkgPrice = item.package?.price || 0
      const dealerPrice = item.package?.dealer_price

      // Use dynamic base price based on this user's current role
      const adminPrice = (isDealer && dealerPrice && dealerPrice > 0)
        ? dealerPrice
        : pkgPrice;

      // A parent's cost is the role price (no parent margin above them)
      const parentPrice = adminPrice;

      // Use sub_agent_profit_margin if available, fallback to wholesale_margin for backwards compatibility
      const subAgentMargin = item.sub_agent_profit_margin !== undefined && item.sub_agent_profit_margin !== null
        ? Number(item.sub_agent_profit_margin)
        : (item.wholesale_margin || 0);

      const sellingPrice = parentPrice + subAgentMargin;

      return {
        ...item,
        // Ensure these fields are present
        is_active: item.is_active !== undefined ? item.is_active : true,
        // parent_price: the base cost (this user's role price)
        parent_price: parentPrice,
        // selling_price: what the sub-agent will pay this user
        selling_price: sellingPrice,
        // profit_margin for display: the user's own profit from this sub-agent
        profit_margin: subAgentMargin,
        is_dealer: isDealer // Include for frontend use
      }
    })

    return NextResponse.json({ catalog: catalogWithPrices, is_dealer: isDealer })

  } catch (error) {
    console.error("Error in sub-agent-catalog API:", error)
    return NextResponse.json(
      { error: "Failed to load catalog. Please try again." },
      { status: 500 }
    )
  }
}

// POST: Add package to sub-agent catalog
export async function POST(request: NextRequest) {
  try {
    const supabase = getSupabaseClient()

    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await request.json()
    const { package_id, wholesale_margin, parent_price, sub_agent_profit_margin } = body

    // Support both old (wholesale_margin) and new (sub_agent_profit_margin) field names
    const profitMargin = sub_agent_profit_margin !== undefined ? sub_agent_profit_margin : wholesale_margin

    if (!package_id || profitMargin === undefined) {
      return NextResponse.json({ error: "Package ID and profit margin required" }, { status: 400 })
    }

    // Get user's shop
    const { data: shop, error: shopError } = await supabase
      .from("user_shops")
      .select("id, parent_shop_id")
      .eq("user_id", user.id)
      .single()

    if (shopError || !shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    // Determine which table to use
    const tableName = shop.parent_shop_id ? "sub_agent_shop_packages" : "sub_agent_catalog"

    // Check if already in catalog
    const { data: existing } = await supabase
      .from(tableName)
      .select("id")
      .eq("shop_id", shop.id)
      .eq("package_id", package_id)
      .single()

    if (existing) {
      // Update existing - use sub_agent_profit_margin if provided, fallback to wholesale_margin
      const updateData: any = {
        is_active: true,
        updated_at: new Date().toISOString()
      }
      if (sub_agent_profit_margin !== undefined) {
        updateData.sub_agent_profit_margin = sub_agent_profit_margin
      } else if (wholesale_margin !== undefined) {
        updateData.wholesale_margin = wholesale_margin
      }
      if (parent_price !== undefined) {
        updateData.parent_price = parent_price
      }

      const { data: updated, error: updateError } = await supabase
        .from(tableName)
        .update(updateData)
        .eq("id", existing.id)
        .select()
        .single()

      if (updateError) {
        return NextResponse.json({ error: "Failed to update catalog" }, { status: 500 })
      }

      return NextResponse.json({ success: true, item: updated, action: "updated" })
    }

    // Insert new - store sub_agent_profit_margin if provided
    const insertData: any = {
      shop_id: shop.id,
      package_id,
      is_active: true
    }
    if (sub_agent_profit_margin !== undefined) {
      insertData.sub_agent_profit_margin = sub_agent_profit_margin
    } else if (wholesale_margin !== undefined) {
      insertData.wholesale_margin = wholesale_margin
    }
    if (parent_price !== undefined) {
      insertData.parent_price = parent_price
    }

    const { data: newItem, error: insertError } = await supabase
      .from(tableName)
      .insert(insertData)
      .select()
      .single()

    if (insertError) {
      console.error("Error adding to catalog:", insertError)
      return NextResponse.json({ error: "Failed to add to catalog" }, { status: 500 })
    }

    return NextResponse.json({ success: true, item: newItem, action: "created" })

  } catch (error) {
    console.error("Error in sub-agent-catalog API:", error)
    return NextResponse.json(
      { error: "Failed to add to catalog. Please try again." },
      { status: 500 }
    )
  }
}

// PUT: Update a catalog item (margin or is_active status)
export async function PUT(request: NextRequest) {
  try {
    const supabase = getSupabaseClient()

    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await request.json()
    const { catalog_id, wholesale_margin, sub_agent_profit_margin, parent_price, is_active } = body

    if (!catalog_id) {
      return NextResponse.json({ error: "Catalog ID required" }, { status: 400 })
    }

    // Get user's shop
    const { data: shop, error: shopError } = await supabase
      .from("user_shops")
      .select("id, parent_shop_id")
      .eq("user_id", user.id)
      .single()

    if (shopError || !shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    // Determine which table to update based on shop type
    const tableName = shop.parent_shop_id ? "sub_agent_shop_packages" : "sub_agent_catalog"

    // Build update object
    const updateData: any = {
      updated_at: new Date().toISOString()
    }

    if (tableName === "sub_agent_shop_packages") {
      // For sub-agent's own packages
      if (sub_agent_profit_margin !== undefined) {
        updateData.sub_agent_profit_margin = sub_agent_profit_margin
      }
      if (parent_price !== undefined) {
        updateData.parent_price = parent_price
      }
    } else {
      // For parent's catalog offerings
      if (wholesale_margin !== undefined) {
        updateData.wholesale_margin = wholesale_margin
      }
    }

    if (is_active !== undefined) {
      updateData.is_active = is_active
    }

    // Update (only if belongs to user's shop)
    const { data: updated, error: updateError } = await supabase
      .from(tableName)
      .update(updateData)
      .eq("id", catalog_id)
      .eq("shop_id", shop.id)
      .select()
      .single()

    if (updateError) {
      console.error("Error updating catalog:", updateError)
      return NextResponse.json({ error: "Failed to update catalog" }, { status: 500 })
    }

    return NextResponse.json({ success: true, item: updated })

  } catch (error) {
    console.error("Error in sub-agent-catalog PUT:", error)
    return NextResponse.json(
      { error: "Failed to update catalog. Please try again." },
      { status: 500 }
    )
  }
}

// DELETE: Remove package from sub-agent catalog
export async function DELETE(request: NextRequest) {
  try {
    const supabase = getSupabaseClient()

    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const url = new URL(request.url)
    const catalogId = url.searchParams.get("id")

    if (!catalogId) {
      return NextResponse.json({ error: "Catalog item ID required" }, { status: 400 })
    }

    // Get user's shop
    const { data: shop, error: shopError } = await supabase
      .from("user_shops")
      .select("id, parent_shop_id")
      .eq("user_id", user.id)
      .single()

    if (shopError || !shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    // Determine which table to check based on shop type
    const tableName = shop.parent_shop_id ? "sub_agent_shop_packages" : "sub_agent_catalog"

    // Get the catalog item to be deleted to find which package it is
    const { data: catalogItem, error: itemError } = await supabase
      .from(tableName)
      .select("id, shop_id, package_id")
      .eq("id", catalogId)
      .single()

    if (itemError || !catalogItem) {
      return NextResponse.json({ error: "Catalog item not found" }, { status: 404 })
    }

    // Only allow deletion if it belongs to the user's shop
    if (catalogItem.shop_id !== shop.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
    }

    // Delete the item
    const { error: deleteError } = await supabase
      .from(tableName)
      .delete()
      .eq("id", catalogId)

    if (deleteError) {
      return NextResponse.json({ error: "Failed to delete from catalog" }, { status: 500 })
    }

    // If this is a parent shop deleting from their catalog, 
    // also deactivate the same package for all sub-agents in sub_agent_catalog
    if (!shop.parent_shop_id) {
      // This is a parent shop, so deactivate for all sub-agents
      const { error: deactivateError } = await supabase
        .from("sub_agent_catalog")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("package_id", catalogItem.package_id)
        .in("shop_id",
          (await supabase
            .from("user_shops")
            .select("id")
            .eq("parent_shop_id", shop.id)
          ).data?.map((s: any) => s.id) || []
        )
    }

    return NextResponse.json({ success: true })

  } catch (error) {
    console.error("Error in sub-agent-catalog DELETE:", error)
    return NextResponse.json(
      { error: "Failed to remove from catalog. Please try again." },
      { status: 500 }
    )
  }
}
