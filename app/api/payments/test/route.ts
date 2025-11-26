import { NextRequest, NextResponse } from "next/server"

const PAYSTACK_BASE_URL = "https://api.paystack.co"
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY

/**
 * Test endpoint to debug Paystack initialization
 * Logs the exact response from Paystack
 */
export async function POST(request: NextRequest) {
  try {
    const { amount, email } = await request.json()

    if (!amount || !email) {
      return NextResponse.json(
        { error: "Missing amount or email" },
        { status: 400 }
      )
    }

    const testPayload = {
      email,
      amount: amount * 100, // in kobo
      reference: `TEST-${Date.now()}`,
      metadata: {
        test: true,
      },
    }

    console.log("Sending to Paystack:", JSON.stringify(testPayload, null, 2))

    const response = await fetch(`${PAYSTACK_BASE_URL}/transaction/initialize`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(testPayload),
    })

    const data = await response.json()

    console.log("Paystack Response:", JSON.stringify(data, null, 2))

    return NextResponse.json({
      success: data.status,
      message: data.message,
      fullResponse: data,
      statusCode: response.status,
    })
  } catch (error) {
    console.error("Error testing payment:", error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Test failed",
      },
      { status: 500 }
    )
  }
}
