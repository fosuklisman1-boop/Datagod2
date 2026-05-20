import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { fetchBankList, MoolreBank } from "@/lib/moolre-transfer"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Module-level cache — survives across requests in the same serverless instance
let cachedBanks: MoolreBank[] | null = null
let cacheExpiry = 0

export async function GET(request: NextRequest) {
  // Require authenticated user
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const token = authHeader.substring(7)
  const { data: { user }, error: userError } = await supabase.auth.getUser(token)
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Return cached list if still fresh (24h TTL)
  if (cachedBanks && Date.now() < cacheExpiry) {
    return NextResponse.json(cachedBanks)
  }

  const banks = await fetchBankList()
  cachedBanks = banks
  cacheExpiry = Date.now() + 24 * 60 * 60 * 1000

  return NextResponse.json(banks)
}
