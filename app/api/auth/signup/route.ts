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
    const { email, firstName, lastName, phoneNumber } = await request.json()

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

    // Verify the caller's identity via their Supabase session token
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const token = authHeader.slice(7)
    const { data: tokenUser, error: tokenError } = await supabaseServiceRole.auth.getUser(token)
    if (tokenError || !tokenUser?.user?.id) {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 })
    }
    const userId = tokenUser.user.id

    // Check if signups are enabled globally and fetch default role
    const { data: settings } = await supabaseServiceRole
      .from("app_settings")
      .select("signups_enabled, signup_default_role")
      .single()

    if (settings && settings.signups_enabled === false) {
      return NextResponse.json(
        { error: "New user registrations are currently disabled by the administrator." },
        { status: 403 }
      )
    }

    const validSignupRoles = ['user', 'dealer']
    const rawRole: string = settings?.signup_default_role || 'user'
    const defaultRole: string = validSignupRoles.includes(rawRole) ? rawRole : 'user'

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
          role: defaultRole,
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

    // Cross-account velocity tracking. The per-IP signup rate limit (5/hr) at
    // the top of this handler is the hard cap; this is a softer signal that
    // flags suspicious patterns (e.g., 3+ accounts in 24h from one IP) for
    // admin investigation. We use a wide window (100/24h) so the counter
    // doesn't actually block traffic — we just inspect `remaining` for
    // velocity insight.
    try {
      const velocityProbe = await applyRateLimit(request, "signup_velocity_probe", 100, 24 * 60 * 60 * 1000)
      const recentSignupsFromThisIp = 100 - velocityProbe.remaining
      if (recentSignupsFromThisIp >= 3) {
        console.warn(`[SIGNUP] 🚨 Velocity alert: ${recentSignupsFromThisIp} signups from this IP in last 24h. New user_id=${userId} phone=${phoneNumber}`)
        // Best-effort admin notification — non-blocking
        await supabaseServiceRole.from("notifications").insert([{
          user_id: null,
          title: "Multi-account signup alert",
          message: `${recentSignupsFromThisIp} accounts created from the same IP in 24h. Latest: ${firstName} ${lastName} (${phoneNumber}). Investigate for fraud-ring activity.`,
          type: "fraud_alert",
          metadata: { recent_count: recentSignupsFromThisIp, new_user_id: userId, phone: phoneNumber },
          is_read: false,
          created_at: new Date().toISOString(),
        }]).then(({ error }) => {
          if (error) console.warn("[SIGNUP] Velocity notification insert failed:", error.message)
        })
      }
    } catch (e) {
      // Velocity tracking failure shouldn't block signup
      console.warn("[SIGNUP] Velocity probe failed:", e instanceof Error ? e.message : e)
    }

    // Sync role into auth user_metadata so session reflects it immediately
    if (defaultRole !== 'user') {
      supabaseServiceRole.auth.admin.updateUserById(userId, {
        user_metadata: { role: defaultRole }
      }).catch((err) => {
        console.error("Auth metadata sync error:", err)
      })
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
