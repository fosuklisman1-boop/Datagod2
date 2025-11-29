import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET() {
  try {
    const { data, error } = await supabase
      .from("support_settings")
      .select("*")
      .limit(1)
      .single()

    if (error && error.code !== "PGRST116") {
      console.error("Error fetching support settings:", error)
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      )
    }

    // Return default if not found
    if (!data) {
      return NextResponse.json({
        success: true,
        data: {
          support_whatsapp: "233501234567",
          support_email: "support@datagod.com",
          support_phone: "0501234567"
        }
      })
    }

    return NextResponse.json({
      success: true,
      data
    })
  } catch (error: any) {
    console.error("Error in GET /api/support-settings:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
