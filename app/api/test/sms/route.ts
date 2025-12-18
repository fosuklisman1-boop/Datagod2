import { NextRequest, NextResponse } from "next/server"
import { sendSMS } from "@/lib/sms-service"

/**
 * Test SMS endpoint - for debugging only
 * GET /api/test/sms?phone=0555773910&message=test
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const phone = searchParams.get("phone")
    const message = searchParams.get("message") || "DATAGOD: Test SMS"

    console.log("[TEST-SMS] Endpoint called with:", { phone, message })

    if (!phone) {
      return NextResponse.json(
        { error: "Phone number required" },
        { status: 400 }
      )
    }

    // Send SMS directly
    const result = await sendSMS({
      phone,
      message,
      type: 'test',
      reference: 'test-' + Date.now(),
    })

    console.log("[TEST-SMS] Result:", result)

    return NextResponse.json({
      success: true,
      message: "SMS test sent",
      result,
    })
  } catch (error) {
    console.error("[TEST-SMS] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Test failed" },
      { status: 500 }
    )
  }
}
