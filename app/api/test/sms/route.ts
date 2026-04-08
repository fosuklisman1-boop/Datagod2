import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { sendSMS } from "@/lib/sms-service"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {

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
      })
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
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
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
