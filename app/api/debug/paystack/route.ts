import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

/**
 * Debug endpoint to help diagnose Paystack integration issues
 * This endpoint tests what's being sent to Paystack and receives back
 */
export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const body = await request.json()
    const { amount, email } = body

    if (!amount || !email) {
      return NextResponse.json(
        { error: "Missing amount or email" },
        { status: 400 }
      )
    }

    // Test 1: Check environment variables
    const envCheck = {
      PAYSTACK_SECRET_KEY: !!process.env.PAYSTACK_SECRET_KEY,
      PAYSTACK_CURRENCY: process.env.PAYSTACK_CURRENCY || "GHS (default)",
    }

    // Test 2: Build the request payload exactly as the lib does
    const testPayload = {
      email: email,
      amount: Math.round(parseFloat(amount) * 100),
      reference: `DEBUG-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      metadata: {
        type: "wallet_topup",
        test: true,
      },
      channels: ["card", "mobile_money", "bank_transfer"],
    }

    // Test 3: Make request to Paystack
    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(testPayload),
    })

    const data = await response.json()
    const headers = Object.fromEntries(response.headers.entries())

    return NextResponse.json(
      {
        success: response.status === 200 && data.status,
        statusCode: response.status,
        message: data.message,
        envCheck,
        data: {
          authorizationUrl: data.data?.authorization_url,
          accessCode: data.data?.access_code,
          reference: data.data?.reference,
        },
        diagnostic: {
          responseStatus: response.status,
          apiResponse: data,
          contentType: headers["content-type"],
        },
      },
      { status: response.status }
    )
  } catch (error) {
    console.error("[PAYSTACK-DEBUG] Error:", error instanceof Error ? error.message : error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Debug test failed" },
      { status: 500 }
    )
  }
}
