import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function GET() {
  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })

    // Get all shops
    const { data: allShops, error: allError } = await supabase
      .from("user_shops")
      .select("*")
      .order("created_at", { ascending: false })

    if (allError) {
      return NextResponse.json({ error: allError.message }, { status: 500 })
    }

    // Get pending shops - shops with is_active=false
    const { data: pendingShops, error: pendingError } = await supabase
      .from("user_shops")
      .select("*")
      .eq("is_active", false)
      .order("created_at", { ascending: false })

    if (pendingError) {
      return NextResponse.json({ error: pendingError.message }, { status: 500 })
    }

    // Get active shops
    const { data: activeShops, error: activeError } = await supabase
      .from("user_shops")
      .select("*")
      .eq("is_active", true)
      .order("created_at", { ascending: false })

    if (activeError) {
      return NextResponse.json({ error: activeError.message }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      summary: {
        total: allShops?.length || 0,
        pending: pendingShops?.length || 0,
        active: activeShops?.length || 0,
      },
      allShops: allShops || [],
      pendingShops: pendingShops || [],
      activeShops: activeShops || [],
    })
  } catch (error: any) {
    console.error("Error in debug shops:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
