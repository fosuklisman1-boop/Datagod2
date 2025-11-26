import { NextRequest, NextResponse } from "next/server"

/**
 * Debug endpoint to help diagnose Paystack integration issues
 * This endpoint tests what's being sent to Paystack and receives back
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { amount, email } = body

    if (!amount || !email) {
      return NextResponse.json(
        { error: "Missing amount or email" },
        { status: 400 }
      )
    }

    console.log("\n=== PAYSTACK DEBUG ===")
    console.log("Request Body Received:", JSON.stringify(body, null, 2))

    // Test 1: Check environment variables
    console.log("\n1. Environment Check:")
    console.log("  PAYSTACK_SECRET_KEY exists:", !!process.env.PAYSTACK_SECRET_KEY)
    console.log("  PAYSTACK_CURRENCY:", process.env.PAYSTACK_CURRENCY || "GHS (default)")

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

    console.log("\n2. Payload to Paystack:")
    console.log(JSON.stringify(testPayload, null, 2))

    // Test 3: Make request to Paystack
    console.log("\n3. Making request to Paystack...")
    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(testPayload),
    })

    const data = await response.json()

    console.log("\n4. Paystack Response:")
    console.log("  Status Code:", response.status)
    console.log("  Response Body:", JSON.stringify(data, null, 2))

    // Test 4: Parse response headers for debugging
    console.log("\n5. Response Headers:")
    const headers = Object.fromEntries(response.headers.entries())
    console.log("  Content-Type:", headers["content-type"])
    console.log("  X-Message:", headers["x-message"] || "None")

    // Test 5: Validate the response
    console.log("\n6. Validation:")
    console.log("  Success:", !!data.status)
    console.log("  Has access_code:", !!data.data?.access_code)
    console.log("  Has authorization_url:", !!data.data?.authorization_url)

    // Return comprehensive diagnostic info
    return NextResponse.json(
      {
        success: response.status === 200 && data.status,
        statusCode: response.status,
        message: data.message,
        data: {
          authorizationUrl: data.data?.authorization_url,
          accessCode: data.data?.access_code,
          reference: data.data?.reference,
        },
        diagnostic: {
          payloadSent: testPayload,
          responseStatus: response.status,
          apiResponse: data,
          headers: headers,
        },
      },
      { status: response.status }
    )
  } catch (error) {
    console.error("\n=== PAYSTACK DEBUG ERROR ===")
    console.error(error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Debug test failed",
        stack: error instanceof Error ? error.stack : undefined,
      },
      { status: 500 }
    )
  }
}
