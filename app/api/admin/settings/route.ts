import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

// Force dynamic to prevent caching - announcements need fresh data
export const dynamic = 'force-dynamic'
export const revalidate = 0

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// GET settings
export async function GET(request: NextRequest) {
  try {
    console.log("[ADMIN-SETTINGS-GET] Fetching app settings...")
    const { data: settings, error } = await supabase
      .from("app_settings")
      .select("*")
      .single()

    if (error && error.code !== "PGRST116") {
      console.error("[ADMIN-SETTINGS-GET] Query error:", error)
      return NextResponse.json({ error: error.message }, { status: 400 })
    }

    // If no settings exist, create default row
    if (!settings) {
      console.log("[ADMIN-SETTINGS-GET] No settings found, creating defaults...")
      const { data: newSettings, error: insertError } = await supabase
        .from("app_settings")
        .insert([{
          join_community_link: "",
          ordering_enabled: true,
          announcement_enabled: false,
          announcement_title: "",
          announcement_message: "",
          paystack_fee_percentage: 3.0,
          wallet_topup_fee_percentage: 0,
          withdrawal_fee_percentage: 0,
          price_adjustment_mtn: 0,
          price_adjustment_telecel: 0,
          price_adjustment_at_ishare: 0,
          price_adjustment_at_bigtime: 0
        }])
        .select()
        .single()

      if (insertError) {
        console.error("[ADMIN-SETTINGS-GET] Error creating app_settings:", insertError)
        // Return default if creation fails
        return NextResponse.json({
          id: null,
          join_community_link: "",
          ordering_enabled: true,
          announcement_enabled: false,
          announcement_title: "",
          announcement_message: "",
          paystack_fee_percentage: 3.0,
          wallet_topup_fee_percentage: 0,
          withdrawal_fee_percentage: 0,
          created_at: null,
          updated_at: null,
        })
      }

      console.log("[ADMIN-SETTINGS-GET] Created new settings:", newSettings)
      return NextResponse.json(newSettings)
    }

    console.log("[ADMIN-SETTINGS-GET] Returning settings:", {
      announcement_enabled: settings.announcement_enabled,
      announcement_title: settings.announcement_title,
      announcement_message: settings.announcement_message,
    })
    return NextResponse.json(settings)
  } catch (error) {
    console.error("[ADMIN-SETTINGS-GET] Unexpected error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}

// UPDATE settings
export async function PUT(request: NextRequest) {
  try {
    // Verify admin authorization
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "No authorization token" },
        { status: 401 }
      )
    }

    const token = authHeader.split(" ")[1]

    // Verify user is admin
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)

    if (userError || !user) {
      return NextResponse.json(
        { error: "Invalid token" },
        { status: 401 }
      )
    }

    // Check if user is admin via user_metadata
    const role = user.user_metadata?.role
    if (role !== "admin") {
      return NextResponse.json(
        { error: "User is not an admin" },
        { status: 403 }
      )
    }

    const body = await request.json()
    console.log("[SETTINGS-API] Received update body:", JSON.stringify(body, null, 2))

    // Construct update object with only defined fields
    const updates: any = {
      updated_at: new Date().toISOString()
    }

    const fields = [
      'join_community_link',
      'ordering_enabled',
      'announcement_enabled',
      'announcement_title',
      'announcement_message',
      'paystack_fee_percentage',
      'wallet_topup_fee_percentage',
      'withdrawal_fee_percentage',
      'price_adjustment_mtn',
      'price_adjustment_telecel',
      'price_adjustment_at_ishare',
      'price_adjustment_at_bigtime'
    ]

    fields.forEach(field => {
      if (body[field] !== undefined) {
        updates[field] = body[field]
      }
    })

    console.log("[SETTINGS-API] Constructed updates:", updates)

    // Validate fee percentages if present
    const {
      paystack_fee_percentage,
      wallet_topup_fee_percentage,
      withdrawal_fee_percentage,
      join_community_link
    } = updates

    if (paystack_fee_percentage !== undefined && (paystack_fee_percentage < 0 || paystack_fee_percentage > 100)) {
      return NextResponse.json(
        { error: "paystack_fee_percentage must be between 0 and 100" },
        { status: 400 }
      )
    }

    if (wallet_topup_fee_percentage !== undefined && (wallet_topup_fee_percentage < 0 || wallet_topup_fee_percentage > 100)) {
      return NextResponse.json(
        { error: "wallet_topup_fee_percentage must be between 0 and 100" },
        { status: 400 }
      )
    }

    if (withdrawal_fee_percentage !== undefined && (withdrawal_fee_percentage < 0 || withdrawal_fee_percentage > 100)) {
      return NextResponse.json(
        { error: "withdrawal_fee_percentage must be between 0 and 100" },
        { status: 400 }
      )
    }

    // Validate URL format if present
    if (join_community_link) {
      try {
        new URL(join_community_link)
      } catch {
        return NextResponse.json(
          { error: "Invalid URL format" },
          { status: 400 }
        )
      }
    }

    // Get existing settings
    const { data: existingSettings } = await supabase
      .from("app_settings")
      .select("id")
      .single()

    let result

    if (existingSettings) {
      // Update existing
      console.log("[SETTINGS-API] Updating existing settings:", existingSettings.id)
      const { data, error } = await supabase
        .from("app_settings")
        .update(updates)
        .eq("id", existingSettings.id)
        .select()
        .single()

      if (error) {
        console.error("[SETTINGS-API] Update error:", error)
        return NextResponse.json({ error: error.message }, { status: 400 })
      }

      console.log("[SETTINGS-API] Update success:", data)
      result = data
    } else {
      // Create new with defaults mixed with updates
      console.log("[SETTINGS-API] Creating new settings row")
      const defaults = {
        join_community_link: "",
        ordering_enabled: true,
        announcement_enabled: false,
        announcement_title: "",
        announcement_message: "",
        paystack_fee_percentage: 3.0,
        wallet_topup_fee_percentage: 0,
        withdrawal_fee_percentage: 0,
        price_adjustment_mtn: 0,
        price_adjustment_telecel: 0,
        price_adjustment_at_ishare: 0,
        price_adjustment_at_bigtime: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      const newSettings = { ...defaults, ...updates }

      const { data, error } = await supabase
        .from("app_settings")
        .insert([newSettings])
        .select()
        .single()

      if (error) {
        console.error("[SETTINGS-API] Insert error:", error)
        return NextResponse.json({ error: error.message }, { status: 400 })
      }

      result = data
    }

    return NextResponse.json({
      success: true,
      settings: result,
    })
  } catch (error) {
    console.error("[SETTINGS-API] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}
