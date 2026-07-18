import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { validateAccountName } from "@/lib/moolre-transfer"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { withdrawalId } = await request.json()
    if (!withdrawalId) {
      return NextResponse.json({ error: "withdrawalId required" }, { status: 400 })
    }

    const { data: withdrawal, error } = await supabase
      .from("withdrawal_requests")
      .select("withdrawal_method, account_details")
      .eq("id", withdrawalId)
      .single()

    if (error || !withdrawal) {
      return NextResponse.json({ error: "Withdrawal not found" }, { status: 404 })
    }

    if (withdrawal.withdrawal_method === "bank_transfer") {
      return NextResponse.json({ error: "Name validation not supported for bank transfers" }, { status: 400 })
    }

    const details = withdrawal.account_details as any
    const phone: string = details?.phone
    const network: string = details?.network
    const claimedName: string = details?.account_name || ""

    if (!phone || !network) {
      return NextResponse.json({ error: "Missing phone or network in account details" }, { status: 400 })
    }

    const result = await validateAccountName(phone, network)

    const validatedName = result.accountName
    // Simple match: first word of claimed name appears in validated name (case-insensitive)
    const firstWord = claimedName.trim().split(/\s+/)[0]?.toUpperCase() || ""
    const matched = !!validatedName && firstWord.length > 0 && validatedName.toUpperCase().includes(firstWord)

    return NextResponse.json({
      validatedName,
      claimedName,
      matched,
      error: result.error || null,
    })
  } catch (err: any) {
    console.error("[VALIDATE-NAME] Error:", err)
    return NextResponse.json({ error: err.message || "Internal server error" }, { status: 500 })
  }
}
