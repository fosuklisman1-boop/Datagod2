import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

export async function POST(request: NextRequest) {
  try {
    const { phoneNumber } = await request.json()

    // Get the auth token from the request
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    const token = authHeader.slice(7)

    // Create a service role client
    const supabaseServiceRole = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      process.env.SUPABASE_SERVICE_ROLE_KEY || "",
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      }
    )

    // Verify the user's token
    const { data: { user }, error: authError } = await supabaseServiceRole.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json(
        { error: "Invalid authentication" },
        { status: 401 }
      )
    }

    // Phone number is required
    if (!phoneNumber || phoneNumber.trim() === '') {
      return NextResponse.json(
        { error: "Phone number is required" },
        { status: 400 }
      )
    }

    // Validate phone number (9-10 digits)
    const phoneDigits = (phoneNumber || '').replace(/\D/g, '')
    if (phoneDigits.length < 9 || phoneDigits.length > 10) {
      return NextResponse.json(
        { error: "Phone number must be 9 or 10 digits" },
        { status: 400 }
      )
    }

    // Check if phone number already exists for a DIFFERENT user
    const { data: existingUser, error: checkError } = await supabaseServiceRole
      .from("users")
      .select("id")
      .eq("phone_number", phoneNumber)
      .neq("id", user.id) // Exclude current user
      .maybeSingle()

    if (existingUser) {
      return NextResponse.json(
        { error: "This phone number is already registered" },
        { status: 400 }
      )
    }

    // Update the user's phone number using service role (bypasses RLS)
    const { error: updateError } = await supabaseServiceRole
      .from("users")
      .update({ phone_number: phoneNumber })
      .eq("id", user.id)

    if (updateError) {
      console.error("Error updating phone number:", updateError)
      return NextResponse.json(
        { error: "Failed to update phone number" },
        { status: 500 }
      )
    }

    return NextResponse.json(
      { success: true, message: "Phone number updated successfully" },
      { status: 200 }
    )
  } catch (error: any) {
    console.error("Update phone API error:", error)
    return NextResponse.json(
      { error: "Failed to update phone number" },
      { status: 500 }
    )
  }
}
