import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/rate-limiter"
import { RATE_LIMITS } from "@/lib/rate-limit-config"
import { sendSMS, SMSTemplates } from "@/lib/sms-service"

export async function POST(request: NextRequest) {
  // Apply rate limiting
  const rateLimit = await applyRateLimit(
    request,
    'password_reset',
    RATE_LIMITS.PASSWORD_RESET.maxRequests,
    RATE_LIMITS.PASSWORD_RESET.windowMs
  )

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: RATE_LIMITS.PASSWORD_RESET.message },
      {
        status: 429,
        headers: {
          'X-RateLimit-Limit': RATE_LIMITS.PASSWORD_RESET.maxRequests.toString(),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': new Date(rateLimit.resetAt).toISOString(),
        }
      }
    )
  }

  try {
    const { contact } = await request.json()

    if (!contact || contact.trim() === '') {
      return NextResponse.json(
        { error: "Email or phone number is required." },
        { status: 400 }
      )
    }

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

    // Find the user by email or phone
    const normalizedContact = contact.trim().toLowerCase()
    
    // First try email
    let userQuery = supabaseServiceRole
      .from("users")
      .select("id, email, phone_number, first_name")
      .eq("email", normalizedContact)
      .maybeSingle()
      
    let { data: user, error: userError } = await userQuery

    // If not found by email, try phone
    if (!user) {
      // Very basic normalization for lookup
      let phoneQuery = normalizedContact
      if (phoneQuery.startsWith('0')) {
        // Allow fallback lookup
        const withCode = '+233' + phoneQuery.substring(1)
        const { data: phoneUser } = await supabaseServiceRole
          .from("users")
          .select("id, email, phone_number, first_name")
          .or(`phone_number.ilike.%${phoneQuery}%,phone_number.ilike.%${withCode}%`)
          .limit(1)
          .maybeSingle()
          
        user = phoneUser
      } else {
        const { data: phoneUser } = await supabaseServiceRole
          .from("users")
          .select("id, email, phone_number, first_name")
          .ilike("phone_number", `%${phoneQuery}%`)
          .limit(1)
          .maybeSingle()
          
        user = phoneUser
      }
    }

    if (!user) {
      // ANTI-ENUMERATION: Do not reveal if the account exists or not.
      // Return a 200 OK with a generic message and a simulated slight delay 
      // (timing attacks are harder over the network, but good practice).
      await new Promise(resolve => setTimeout(resolve, 500))

      return NextResponse.json(
        { 
          success: true, 
          message: "If an account matches that contact information, a password reset link has been sent.",
          methods: { email: contact.includes('@'), sms: !contact.includes('@') }
        },
        { status: 200 }
      )
    }

    // Insert reset token (expires in 5 minutes)
    const expiresAt = new Date()
    expiresAt.setMinutes(expiresAt.getMinutes() + 5)

    const { data: tokenData, error: tokenError } = await supabaseServiceRole
      .from("password_reset_requests")
      .insert({
        user_id: user.id,
        email: user.email,
        phone_number: user.phone_number,
        expires_at: expiresAt.toISOString(),
      })
      .select("id")
      .single()

    if (tokenError || !tokenData) {
      console.error("[FORGOT-PASSWORD] Token creation error:", tokenError)
      return NextResponse.json(
        { error: "Failed to generate password reset request." },
        { status: 500 }
      )
    }

    const resetToken = tokenData.id
    const resetUrl = `${process.env.NEXT_PUBLIC_APP_URL}/auth/reset-password?token=${resetToken}`

    const results = { email: false, sms: false }

    // Send Email
    if (user.email) {
      try {
        const { sendEmail, EmailTemplates } = await import("@/lib/email-service")
        const payload = EmailTemplates.passwordReset(resetUrl)
        await sendEmail({
          to: [{ email: user.email, name: user.first_name || "User" }],
          subject: payload.subject,
          htmlContent: payload.html,
          type: 'password_reset_link'
        })
        results.email = true
      } catch (e) {
        console.error("[FORGOT-PASSWORD] Failed to send email:", e)
      }
    }

    // Send SMS
    if (user.phone_number) {
      try {
        await sendSMS({
          phone: user.phone_number,
          message: SMSTemplates.passwordReset(resetUrl),
          type: 'password_reset_link'
        })
        results.sms = true
      } catch (e) {
        console.error("[FORGOT-PASSWORD] Failed to send SMS:", e)
      }
    }

    if (!results.email && !results.sms) {
      // Both failed
      return NextResponse.json(
        { error: "Failed to send reset instructions. Please contact support." },
        { status: 500 }
      )
    }

    return NextResponse.json(
      { 
        success: true, 
        message: "If an account matches that contact information, a password reset link has been sent.",
        methods: { email: results.email, sms: results.sms }
      },
      { status: 200 }
    )
  } catch (error: any) {
    console.error("[FORGOT-PASSWORD] Exception:", error)
    return NextResponse.json(
      { error: "An unexpected error occurred." },
      { status: 500 }
    )
  }
}
