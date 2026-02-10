import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { RATE_LIMITS } from "@/lib/rate-limit-config"

export async function POST(request: NextRequest) {
  // Apply rate limiting: 5 signups per hour per IP
  const rateLimit = await applyRateLimit(
    request,
    'signup',
    RATE_LIMITS.SIGNUP.maxRequests,
    RATE_LIMITS.SIGNUP.windowMs
  )

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: RATE_LIMITS.SIGNUP.message },
      {
        status: 429,
        headers: {
          'X-RateLimit-Limit': RATE_LIMITS.SIGNUP.maxRequests.toString(),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': new Date(rateLimit.resetAt).toISOString(),
        }
      }
    )
  }

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

    // Send Welcome Email
    if (email) {
      import("@/lib/email-service").then(({ sendEmail, EmailTemplates }) => {
        const payload = EmailTemplates.welcomeEmail(firstName || "User");
        sendEmail({
          to: [{ email, name: firstName }],
          subject: payload.subject,
          htmlContent: payload.html,
          userId: userId,
          type: 'welcome_email'
        }).catch(err => {
          console.error("[EMAIL] ❌ Welcome Email FAILED:", err)
          console.error("[EMAIL] Error message:", err?.message)
          console.error("[EMAIL] Error stack:", err?.stack)
          console.error("[EMAIL] Full error object:", JSON.stringify(err, null, 2))
        });
      });
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
