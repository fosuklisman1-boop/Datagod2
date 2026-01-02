import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import crypto from "crypto"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

// Generate a random invite code
function generateInviteCode(): string {
  return crypto.randomBytes(4).toString("hex").toUpperCase()
}

// GET: List invites for a shop
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
      .select("id")
      .eq("user_id", user.id)
      .single()

    if (shopError || !shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    // Get all invites for this shop
    const { data: invites, error: invitesError } = await supabase
      .from("shop_invites")
      .select("*")
      .eq("inviter_shop_id", shop.id)
      .order("created_at", { ascending: false })

    if (invitesError) {
      throw invitesError
    }

    return NextResponse.json({
      success: true,
      invites: invites || []
    })
  } catch (error) {
    console.error("Error fetching invites:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch invites" },
      { status: 500 }
    )
  }
}

// POST: Create a new invite
export async function POST(request: NextRequest) {
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

    // Check user role - must not be a sub_agent (sub-agents can't create sub-agents)
    if (user.user_metadata?.role === "sub_agent") {
      return NextResponse.json(
        { error: "Sub-agents cannot invite other sub-agents" },
        { status: 403 }
      )
    }

    const body = await request.json()
    const { email } = body // Optional email to send invite to

    // Get user's shop
    const { data: shop, error: shopError } = await supabase
      .from("user_shops")
      .select("id, shop_name, is_active")
      .eq("user_id", user.id)
      .single()

    if (shopError || !shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    if (!shop.is_active) {
      return NextResponse.json(
        { error: "Your shop must be active to invite sub-agents" },
        { status: 400 }
      )
    }

    // Generate unique invite code
    let inviteCode = generateInviteCode()
    let attempts = 0
    
    // Ensure code is unique
    while (attempts < 5) {
      const { data: existing } = await supabase
        .from("shop_invites")
        .select("id")
        .eq("invite_code", inviteCode)
        .single()

      if (!existing) break
      inviteCode = generateInviteCode()
      attempts++
    }

    // Create invite
    const { data: invite, error: createError } = await supabase
      .from("shop_invites")
      .insert({
        inviter_shop_id: shop.id,
        invite_code: inviteCode,
        email: email || null,
        status: "pending",
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() // 7 days
      })
      .select()
      .single()

    if (createError) {
      throw createError
    }

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://yoursite.com"
    const inviteUrl = `${baseUrl}/join/${inviteCode}`

    return NextResponse.json({
      success: true,
      invite: {
        ...invite,
        invite_url: inviteUrl
      },
      shop_name: shop.shop_name
    })
  } catch (error) {
    console.error("Error creating invite:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create invite" },
      { status: 500 }
    )
  }
}

// DELETE: Cancel/delete an invite
export async function DELETE(request: NextRequest) {
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

    const { searchParams } = new URL(request.url)
    const inviteId = searchParams.get("id")

    if (!inviteId) {
      return NextResponse.json({ error: "Invite ID required" }, { status: 400 })
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

    // Delete invite (only if it belongs to this shop)
    const { error: deleteError } = await supabase
      .from("shop_invites")
      .delete()
      .eq("id", inviteId)
      .eq("inviter_shop_id", shop.id)

    if (deleteError) {
      throw deleteError
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Error deleting invite:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete invite" },
      { status: 500 }
    )
  }
}
