import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { validateAccountName } from "@/lib/moolre-transfer"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  // Require authenticated user (not just admin)
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const token = authHeader.substring(7)
  const { data: { user }, error: userError } = await supabase.auth.getUser(token)
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { phone, network, accountNumber, sublistid } = body

    if (!network) {
      return NextResponse.json({ error: "network is required" }, { status: 400 })
    }

    const isBankValidation = String(network).toUpperCase() === "BANK"

    if (isBankValidation) {
      // Bank account validation
      if (!accountNumber || !sublistid) {
        return NextResponse.json({ error: "accountNumber and sublistid are required for bank validation" }, { status: 400 })
      }
      const result = await validateAccountName(String(accountNumber).trim(), "BANK", String(sublistid))
      if (!result.accountName) {
        return NextResponse.json({ error: result.error || "Could not verify bank account" }, { status: 400 })
      }
      return NextResponse.json({ accountName: result.accountName })
    }

    // Mobile money validation
    if (!phone) {
      return NextResponse.json({ error: "phone and network are required" }, { status: 400 })
    }

    // Validate phone is a plausible Ghanaian mobile number (9–10 digits, optional leading +233 or 0)
    const normalizedPhone = String(phone).trim()
    const phoneRegex = /^(?:\+233|0)?[2-9]\d{8}$/
    if (!phoneRegex.test(normalizedPhone)) {
      return NextResponse.json({ error: "Invalid phone number format" }, { status: 400 })
    }

    // Validate network is one of the supported values
    const VALID_NETWORKS = ["MTN", "mtn", "Telecel", "telecel", "AT", "at"]
    if (!VALID_NETWORKS.includes(String(network))) {
      return NextResponse.json({ error: "Invalid network. Must be MTN, Telecel, or AT" }, { status: 400 })
    }

    const result = await validateAccountName(normalizedPhone, network)

    if (!result.accountName) {
      return NextResponse.json(
        { error: result.error || "Could not verify account" },
        { status: 400 }
      )
    }

    return NextResponse.json({ accountName: result.accountName })
  } catch (error) {
    console.error("[VALIDATE-ACCOUNT] Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
