import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

export async function POST(request: NextRequest) {
  try {
    const { phoneNumber } = await request.json()

    // Create a service role client on the server
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

    // Check if phone number already exists
    const { data: existingUser, error: checkError } = await supabaseServiceRole
      .from("users")
      .select("id")
      .eq("phone_number", phoneNumber)
      .maybeSingle()

    if (existingUser) {
      return NextResponse.json(
        { error: "This phone number is already registered" },
        { status: 400 }
      )
    }

    // Phone is valid and available
    return NextResponse.json(
      { valid: true, message: "Phone number is available" },
      { status: 200 }
    )
  } catch (error: any) {
    console.error("Check phone API error:", error)
    return NextResponse.json(
      { error: "Failed to validate phone number" },
      { status: 500 }
    )
  }
}
