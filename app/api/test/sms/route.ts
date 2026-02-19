import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { sendSMS } from "@/lib/sms-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(request: NextRequest) {
  try {
    // Check if admin (optional - for security)
    const authHeader = request.headers.get("Authorization")
    let isAdmin = false

    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7)
      const { data: { user } } = await supabase.auth.getUser(token)
      if (user) {
        const { data: userData } = await supabase
          .from("users")
          .select("role")
          .eq("id", user.id)
          .single()
        isAdmin = userData?.role === "admin" || user.user_metadata?.role === "admin"
      }
    }

    // Get phone from query params
    const { searchParams } = new URL(request.url)
    const phone = searchParams.get("phone")
    const testMessage = searchParams.get("message") || "DATAGOD Test: SMS service is working! 🎉"

    // Environment check
    const envCheck = {
      SMS_ENABLED: process.env.SMS_ENABLED,
      SMS_PROVIDER: process.env.SMS_PROVIDER || 'moolre',
      hasMoolreApiKey: !!process.env.MOOLRE_API_KEY,
      moolreApiKeyLength: process.env.MOOLRE_API_KEY?.length || 0,
      hasMoolreSenderId: !!process.env.MOOLRE_SENDER_ID,
      moolreSenderId: process.env.MOOLRE_SENDER_ID || "not set",
      hasMnotifyApiKey: !!process.env.MNOTIFY_API_KEY,
      mnotifySenderId: process.env.MNOTIFY_SENDER_ID || "not set",
    }

    console.log("[SMS-TEST] Environment check:", envCheck)

    // If no phone provided, just return env check
    if (!phone) {
      return NextResponse.json({
        success: true,
        message: "SMS Test Endpoint - Add ?phone=0XXXXXXXXX to send a test SMS",
        envCheck,
        isAdmin,
      })
    }

    // Only allow sending if admin or in development
    if (!isAdmin && process.env.NODE_ENV === "production") {
      return NextResponse.json({
        success: false,
        error: "Admin access required to send test SMS in production",
        envCheck,
      }, { status: 403 })
    }

    console.log("[SMS-TEST] Sending test SMS to:", phone)

    // Send test SMS
    const result = await sendSMS({
      phone,
      message: testMessage,
      type: "test",
      reference: `TEST-${Date.now()}`,
    })

    return NextResponse.json({
      success: result.success,
      result,
      envCheck,
      phone,
      message: testMessage,
    })
  } catch (error: any) {
    console.error("[SMS-TEST] Error:", error)
    return NextResponse.json({
      success: false,
      error: error.message || "Failed to test SMS",
    }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    // Check if admin
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const { data: { user } } = await supabase.auth.getUser(token)

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { data: userData } = await supabase
      .from("users")
      .select("role")
      .eq("id", user.id)
      .single()

    const isAdmin = userData?.role === "admin" || user.user_metadata?.role === "admin"

    if (!isAdmin) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 })
    }

    const body = await request.json()
    const { phone, message } = body

    if (!phone) {
      return NextResponse.json({ error: "Phone number required" }, { status: 400 })
    }

    console.log("[SMS-TEST] Admin sending test SMS to:", phone)

    const result = await sendSMS({
      phone,
      message: message || "DATAGOD Test: SMS service is working! 🎉",
      type: "admin_test",
      reference: `ADMIN-TEST-${Date.now()}`,
      userId: user.id,
    })

    return NextResponse.json({
      success: result.success,
      result,
      phone,
    })
  } catch (error: any) {
    console.error("[SMS-TEST] Error:", error)
    return NextResponse.json({
      success: false,
      error: error.message || "Failed to send test SMS",
    }, { status: 500 })
  }
}
