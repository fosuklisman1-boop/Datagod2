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
    const { phone, network } = await request.json()

    if (!phone || !network) {
      return NextResponse.json({ error: "phone and network are required" }, { status: 400 })
    }

    const result = await validateAccountName(phone, network)

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
