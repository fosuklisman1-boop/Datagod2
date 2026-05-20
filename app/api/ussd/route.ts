import { NextRequest, NextResponse } from "next/server"
import { UzoRequest } from "@/lib/ussd/types"
import { router } from "@/lib/ussd/router"

// Uzo USSD gateway endpoint
// Configure this URL in your Uzo dashboard as the application callback URL.
export async function POST(request: NextRequest) {
  try {
    // Optional: validate Uzo shared secret
    const ussdSecret = process.env.USSD_SECRET
    if (ussdSecret) {
      const providedSecret = request.headers.get("x-ussd-secret") ?? request.nextUrl.searchParams.get("secret")
      if (providedSecret !== ussdSecret) {
        console.warn("[USSD] Rejected request with invalid secret")
        return NextResponse.json({ message: "Unauthorized", ussdServiceOp: 17 }, { status: 401 })
      }
    }

    const body: UzoRequest = await request.json()

    if (!body.sessionID || !body.msisdn || !body.ussdServiceOp) {
      return NextResponse.json(
        { message: "Invalid request", ussdServiceOp: 17 },
        { status: 400 }
      )
    }

    console.log("[USSD] Incoming:", {
      sessionID: body.sessionID,
      msisdn: body.msisdn,
      op: body.ussdServiceOp,
      input: body.ussdString,
      network: body.network,
    })

    const response = await router(body)

    console.log("[USSD] Response:", { op: response.ussdServiceOp, message: response.message.slice(0, 60) })

    return NextResponse.json(response)
  } catch (error) {
    console.error("[USSD] Error:", error)
    return NextResponse.json(
      { message: "Service unavailable. Please try again.", ussdServiceOp: 17 },
      { status: 500 }
    )
  }
}
