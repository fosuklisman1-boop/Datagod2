import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

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

    // Get user's shop
    const { data: shop, error: shopError } = await supabase
      .from("user_shops")
      .select("id")
      .eq("user_id", user.id)
      .single()

    if (shopError || !shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    // Get catalog items with package details
    const { data: catalog, error: catalogError } = await supabase
      .from("sub_agent_catalog")
      .select(`
        id,
        package_id,
        wholesale_margin,
        is_active,
        created_at,
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
      .order("created_at", { ascending: false })

    if (catalogError) {
      console.error("Error fetching catalog:", catalogError)
      return NextResponse.json({ error: "Failed to fetch catalog" }, { status: 500 })
    }

    // Transform to include calculated wholesale price (what this user pays)
    const catalogWithPrices = (catalog || []).map((item: any) => ({
      ...item,
      // For sub-agents: wholesale_price = admin_price + wholesale_margin
      // wholesale_margin here is the TOTAL margin (includes parent's margin)
      wholesale_price: (item.package?.price || 0) + item.wholesale_margin
    }))

    return NextResponse.json({ catalog: catalogWithPrices })

  } catch (error) {
    console.error("Error in sub-agent-catalog API:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch catalog" },
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
    const { package_id, wholesale_margin } = body

    if (!package_id || wholesale_margin === undefined) {
      return NextResponse.json({ error: "Package ID and wholesale margin required" }, { status: 400 })
    }

    // Get user's shop
    const { data: shop, error: shopError } = await supabase
      .from("user_shops")
      .select("id")
      .eq("user_id", user.id)
      .single()

    if (shopError || !shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    // Check if already in catalog
    const { data: existing } = await supabase
      .from("sub_agent_catalog")
      .select("id")
      .eq("shop_id", shop.id)
      .eq("package_id", package_id)
      .single()

    if (existing) {
      // Update existing
      const { data: updated, error: updateError } = await supabase
        .from("sub_agent_catalog")
        .update({
          wholesale_margin,
          is_active: true,
          updated_at: new Date().toISOString()
        })
        .eq("id", existing.id)
        .select()
        .single()

      if (updateError) {
        return NextResponse.json({ error: "Failed to update catalog" }, { status: 500 })
      }

      return NextResponse.json({ success: true, item: updated, action: "updated" })
    }

    // Insert new
    const { data: newItem, error: insertError } = await supabase
      .from("sub_agent_catalog")
      .insert({
        shop_id: shop.id,
        package_id,
        wholesale_margin,
        is_active: true
      })
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
      { error: error instanceof Error ? error.message : "Failed to add to catalog" },
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
    const { catalog_id, wholesale_margin, is_active } = body

    if (!catalog_id) {
      return NextResponse.json({ error: "Catalog ID required" }, { status: 400 })
    }

    // Get user's shop
    const { data: shop, error: shopError } = await supabase
      .from("user_shops")
      .select("id")
      .eq("user_id", user.id)
      .single()

    if (shopError || !shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    // Build update object
    const updateData: any = {
      updated_at: new Date().toISOString()
    }
    
    if (wholesale_margin !== undefined) {
      updateData.wholesale_margin = wholesale_margin
    }
    
    if (is_active !== undefined) {
      updateData.is_active = is_active
    }

    // Update (only if belongs to user's shop)
    const { data: updated, error: updateError } = await supabase
      .from("sub_agent_catalog")
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
      { error: error instanceof Error ? error.message : "Failed to update catalog" },
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

    // Get the catalog item to be deleted to find which package it is
    const { data: catalogItem, error: itemError } = await supabase
      .from("sub_agent_catalog")
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
      .from("sub_agent_catalog")
      .delete()
      .eq("id", catalogId)

    if (deleteError) {
      return NextResponse.json({ error: "Failed to delete from catalog" }, { status: 500 })
    }

    // If this is a parent shop deleting from their catalog, 
    // also deactivate the same package for all sub-agents
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
    console.error("Error in sub-agent-catalog API:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete from catalog" },
      { status: 500 }
    )
  }
}
