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

    // Transform to include calculated wholesale price
    const catalogWithPrices = (catalog || []).map((item: any) => ({
      ...item,
      wholesale_price: item.package.price + item.wholesale_margin
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
      .select("id")
      .eq("user_id", user.id)
      .single()

    if (shopError || !shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    // Delete (only if belongs to user's shop)
    const { error: deleteError } = await supabase
      .from("sub_agent_catalog")
      .delete()
      .eq("id", catalogId)
      .eq("shop_id", shop.id)

    if (deleteError) {
      return NextResponse.json({ error: "Failed to delete from catalog" }, { status: 500 })
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
