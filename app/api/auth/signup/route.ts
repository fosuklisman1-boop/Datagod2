import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

export async function POST(request: NextRequest) {
  try {
    const { email, userId, firstName, lastName, phoneNumber } = await request.json()

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

    // Create user profile
    const { data, error } = await supabaseServiceRole
      .from("users")
      .insert([
        {
          id: userId,
          email,
          first_name: firstName || "",
          last_name: lastName || "",
          phone_number: phoneNumber || "",
          created_at: new Date().toISOString(),
        },
      ])
      .select()

    if (error) {
      console.error("Profile creation error:", error)
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      )
    }

    // Create wallet for the user
    const { error: walletError } = await supabaseServiceRole
      .from("wallets")
      .insert([
        {
          user_id: userId,
          balance: 0,
          total_credited: 0,
          total_spent: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ])

    if (walletError) {
      console.error("Wallet creation error:", walletError)
      // Don't fail signup if wallet creation fails, but log it
    }

    return NextResponse.json(
      { profile: data?.[0] },
      { status: 201 }
    )
  } catch (error: any) {
    console.error("Signup API error:", error)
    return NextResponse.json(
      { error: error?.message || "Failed to create profile" },
      { status: 500 }
    )
  }
}
