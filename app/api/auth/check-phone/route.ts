import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { phoneKey } from "@/lib/phone-login/core"
export async function POST(request: NextRequest) {
  try {
    const { phoneNumber, excludeUserId } = await request.json()

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

    // Normalised match (0241234567 == +233241234567 == 233241234567) on the 9 significant digits.
    const key = phoneKey(phoneNumber)
    if (!key) {
      return NextResponse.json(
        { error: "Phone number must be 9 or 10 digits" },
        { status: 400 }
      )
    }

    // Taken when any account holds the number, other than the excluded user (updating their own phone).
    const { data, error: checkError } = await supabaseServiceRole.rpc("phone_login_find_account", { p_sig: key.sig })
    if (checkError) throw checkError
    const found = (Array.isArray(data) ? data[0] : data) as { match_count: number; user_id: string | null } | null
    const count = found?.match_count ?? 0
    const taken = count > 1 || (count === 1 && (!excludeUserId || found?.user_id !== excludeUserId))

    // Always return HTTP 200 regardless of availability.
    // A 400 vs 200 difference was leaking registration status to unauthenticated
    // callers, enabling bulk phone-number enumeration of the user base.
    if (taken) {
      return NextResponse.json(
        { available: false, error: "This phone number is already registered" },
        { status: 200 }
      )
    }

    return NextResponse.json(
      { available: true, message: "Phone number is available" },
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
