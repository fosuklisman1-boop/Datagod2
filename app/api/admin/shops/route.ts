import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET() {
  try {
    const { data, error } = await supabase
      .from("user_shops")
      .select("*")
      .order("created_at", { ascending: false })

    if (error) {
      console.error("Error fetching shops:", error)
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      data: data || []
    })
  } catch (error: any) {
    console.error("Error in GET /api/admin/shops:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
