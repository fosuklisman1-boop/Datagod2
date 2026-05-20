import { NextRequest, NextResponse } from "next/server"
import { UzoRequest } from "@/lib/ussd-shop/types"
import { shopRouter } from "@/lib/ussd-shop/router"

// Shop-code USSD endpoint — separate from the main Datagod USSD.
// Configure this URL in your Uzo dashboard as the shop storefront callback URL.
export async function POST(request: NextRequest) {
  try {
    const ussdSecret = process.env.USSD_SHOP_SECRET
    if (ussdSecret) {
      const provided = request.headers.get("x-ussd-secret") ?? request.nextUrl.searchParams.get("secret")
      if (provided !== ussdSecret) {
        console.warn("[USSD-SHOP] Rejected request with invalid secret")
        return NextResponse.json({ message: "Unauthorized", ussdServiceOp: 17 }, { status: 401 })
      }
    }

    const body: UzoRequest = await request.json()

    if (!body.sessionID || !body.msisdn || !body.ussdServiceOp) {
      return NextResponse.json({ message: "Invalid request", ussdServiceOp: 17 }, { status: 400 })
    }

    console.log("[USSD-SHOP] Incoming:", {
      sessionID: body.sessionID,
      msisdn: body.msisdn,
      op: body.ussdServiceOp,
      input: body.ussdString,
    })

    const response = await shopRouter(body)

    console.log("[USSD-SHOP] Response:", { op: response.ussdServiceOp, message: response.message.slice(0, 60) })

    return NextResponse.json(response)
  } catch (error) {
    console.error("[USSD-SHOP] Error:", error)
    return NextResponse.json(
      { message: "Service unavailable. Please try again.", ussdServiceOp: 17 },
      { status: 500 }
    )
  }
}
