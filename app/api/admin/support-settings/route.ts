import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  try {
    const { support_whatsapp, support_email, support_phone } = await request.json()

    // Validate WhatsApp number format (should be international format)
    if (!support_whatsapp) {
      return NextResponse.json(
        { error: "WhatsApp number is required" },
        { status: 400 }
      )
    }

    // Get existing settings or create new ones
    const { data: existingData } = await supabase
      .from("support_settings")
      .select("id")
      .limit(1)
      .single()

    let result
    if (existingData) {
      // Update existing
      const { data, error } = await supabase
        .from("support_settings")
        .update({
          support_whatsapp,
          support_email,
          support_phone,
          updated_at: new Date().toISOString()
        })
        .eq("id", existingData.id)
        .select()

      if (error) {
        console.error("Error updating support settings:", error)
        return NextResponse.json(
          { error: error.message },
          { status: 500 }
        )
      }
      result = data[0]
    } else {
      // Create new
      const { data, error } = await supabase
        .from("support_settings")
        .insert([{
          support_whatsapp,
          support_email,
          support_phone
        }])
        .select()

      if (error) {
        console.error("Error creating support settings:", error)
        return NextResponse.json(
          { error: error.message },
          { status: 500 }
        )
      }
      result = data[0]
    }

    console.log("Support settings updated:", result)

    return NextResponse.json({
      success: true,
      data: result
    })
  } catch (error: any) {
    console.error("Error in POST /api/admin/support-settings:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
