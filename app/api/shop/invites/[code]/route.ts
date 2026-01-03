import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

interface Params {
  params: Promise<{ code: string }>
}

// GET: Get invite details by code (for join page)
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { code } = await params

    if (!code) {
      return NextResponse.json({ error: "Invite code required" }, { status: 400 })
    }

    // Get invite with shop details
    const { data: invite, error: inviteError } = await supabase
      .from("shop_invites")
      .select(`
        *,
        inviter_shop:user_shops!inviter_shop_id (
          id,
          shop_name,
          shop_slug,
          is_active
        )
      `)
      .eq("invite_code", code.toUpperCase())
      .single()

    if (inviteError || !invite) {
      return NextResponse.json({ error: "Invalid invite code" }, { status: 404 })
    }

    // Check if expired
    if (new Date(invite.expires_at) < new Date()) {
      return NextResponse.json({ error: "This invite has expired" }, { status: 410 })
    }

    // Check if already accepted
    if (invite.status === "accepted") {
      return NextResponse.json({ error: "This invite has already been used" }, { status: 410 })
    }

    // Check if inviter's shop is active
    if (!invite.inviter_shop?.is_active) {
      return NextResponse.json({ error: "The inviting shop is no longer active" }, { status: 410 })
    }

    // Get parent shop's sub-agent catalog (to show what prices sub-agent will pay)
    const { data: catalogItems, error: catalogError } = await supabase
      .from("sub_agent_catalog")
      .select(`
        id,
        wholesale_margin,
        is_active,
        package:packages (
          id,
          network,
          size,
          price
        )
      `)
      .eq("shop_id", invite.inviter_shop.id)
      .eq("is_active", true)

    return NextResponse.json({
      success: true,
      invite: {
        code: invite.invite_code,
        expires_at: invite.expires_at,
        shop_name: invite.inviter_shop.shop_name,
        shop_id: invite.inviter_shop.id
      },
      // Show the wholesale prices (admin price + parent's wholesale margin = what sub-agent pays)
      wholesale_packages: (catalogItems || [])
        .filter((item: any) => item.package?.price != null)
        .map((item: any) => ({
          network: item.package.network,
          size: item.package.size,
          wholesale_price: item.package.price + (item.wholesale_margin || 0)
        }))
    })
  } catch (error) {
    console.error("Error fetching invite:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch invite" },
      { status: 500 }
    )
  }
}

// POST: Accept invite and create sub-agent account
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const { code } = await params
    const body = await request.json()
    const { email, password, first_name, last_name, phone, shop_name, shop_slug } = body

    // Validate required fields
    if (!email || !password || !shop_name || !shop_slug) {
      return NextResponse.json(
        { error: "Email, password, shop name, and shop slug are required" },
        { status: 400 }
      )
    }

    // Get invite
    const { data: invite, error: inviteError } = await supabase
      .from("shop_invites")
      .select(`
        *,
        inviter_shop:user_shops!inviter_shop_id (
          id,
          shop_name,
          tier_level
        )
      `)
      .eq("invite_code", code.toUpperCase())
      .single()

    if (inviteError || !invite) {
      return NextResponse.json({ error: "Invalid invite code" }, { status: 404 })
    }

    // Validate invite
    if (new Date(invite.expires_at) < new Date()) {
      return NextResponse.json({ error: "This invite has expired" }, { status: 410 })
    }

    if (invite.status === "accepted") {
      return NextResponse.json({ error: "This invite has already been used" }, { status: 410 })
    }

    // Check if shop slug is available
    const { data: existingShop } = await supabase
      .from("user_shops")
      .select("id")
      .eq("shop_slug", shop_slug.toLowerCase())
      .single()

    if (existingShop) {
      return NextResponse.json({ error: "This shop URL is already taken" }, { status: 400 })
    }

    // Create user account with sub_agent role
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // Auto-confirm email for sub-agents
      user_metadata: {
        first_name: first_name || "",
        last_name: last_name || "",
        phone: phone || "",
        role: "sub_agent" // Set role to sub_agent
      }
    })

    if (authError || !authData.user) {
      console.error("Error creating user:", authError)
      return NextResponse.json(
        { error: authError?.message || "Failed to create account" },
        { status: 400 }
      )
    }

    const newUserId = authData.user.id
    const parentTierLevel = invite.inviter_shop?.tier_level || 1

    // Create/update user record with sub_agent role
    const { error: userError } = await supabase
      .from("users")
      .upsert({
        id: newUserId,
        email: email,
        first_name: first_name || "",
        last_name: last_name || "",
        phone_number: phone || "",
        role: "sub_agent",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })

    if (userError) {
      console.error("Error creating user record:", userError)
      // Continue anyway - user record might be created by trigger
    }

    // Create wallet for sub-agent
    const { error: walletError } = await supabase
      .from("wallets")
      .insert({
        user_id: newUserId,
        balance: 0,
        total_credited: 0,
        total_spent: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })

    if (walletError) {
      console.error("Error creating wallet:", walletError)
      // Continue anyway - wallet might be created by trigger
    }

    // Create shop for sub-agent
    const { data: newShop, error: shopError } = await supabase
      .from("user_shops")
      .insert({
        user_id: newUserId,
        shop_name: shop_name,
        shop_slug: shop_slug.toLowerCase(),
        parent_shop_id: invite.inviter_shop.id,
        tier_level: parentTierLevel + 1,
        is_active: true, // Auto-activate sub-agent shops
        description: `Sub-agent of ${invite.inviter_shop.shop_name}`
      })
      .select()
      .single()

    if (shopError) {
      console.error("Error creating shop:", shopError)
      // Rollback: delete the created user
      await supabase.auth.admin.deleteUser(newUserId)
      return NextResponse.json(
        { error: "Failed to create shop" },
        { status: 500 }
      )
    }

    // Copy parent's shop packages to sub-agent's shop
    // Sub-agent's base price = parent's selling price (base + profit_margin)
    const { data: parentPackages, error: packagesError } = await supabase
      .from("shop_packages")
      .select(`
        package_id,
        profit_margin,
        is_available,
        package:packages (
          price
        )
      `)
      .eq("shop_id", invite.inviter_shop.id)
      .eq("is_available", true)

    if (!packagesError && parentPackages) {
      const subAgentPackages = parentPackages.map((pkg: any) => ({
        shop_id: newShop.id,
        package_id: pkg.package_id,
        // Sub-agent starts with 0 margin, they can set their own later
        // Their "cost" is parent's price + parent's margin
        profit_margin: 0,
        is_available: true
      }))

      if (subAgentPackages.length > 0) {
        await supabase
          .from("shop_packages")
          .insert(subAgentPackages)
      }
    }

    // Mark invite as accepted
    await supabase
      .from("shop_invites")
      .update({
        status: "accepted",
        accepted_by_user_id: newUserId,
        accepted_at: new Date().toISOString()
      })
      .eq("id", invite.id)

    return NextResponse.json({
      success: true,
      message: "Account created successfully",
      user_id: newUserId,
      shop_id: newShop.id,
      shop_slug: newShop.shop_slug
    })
  } catch (error) {
    console.error("Error accepting invite:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to accept invite" },
      { status: 500 }
    )
  }
}
