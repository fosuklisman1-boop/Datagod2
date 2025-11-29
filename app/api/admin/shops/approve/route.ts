import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  try {
    const { shopId } = await request.json()

    if (!shopId) {
      return NextResponse.json(
        { error: "Missing shopId" },
        { status: 400 }
      )
    }

    // Update shop to active
    const { data, error } = await supabase
      .from("user_shops")
      .update({
        is_active: true,
        updated_at: new Date().toISOString()
      })
      .eq("id", shopId)
      .select()

    if (error) {
      console.error("Error approving shop:", error)
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      )
    }

    console.log(`Shop ${shopId} approved by admin`)

    return NextResponse.json({
      success: true,
      data: data[0]
    })
  } catch (error: any) {
    console.error("Error in POST /api/admin/shops/approve:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
