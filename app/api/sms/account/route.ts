import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { getOrCreateAccountForUser, listUnitTransactions, getPendingUnits } from "@/lib/sms/account-service"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7))
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const account = await getOrCreateAccountForUser(user.id)
  if (!account) {
    return NextResponse.json({ error: "No SMS account for this user" }, { status: 403 })
  }
  const [transactions, pendingUnits] = await Promise.all([
    listUnitTransactions(account.id, 20),
    getPendingUnits(account.id),
  ])
  return NextResponse.json({
    account: {
      id: account.id,
      ownerType: account.owner_type,
      unitBalance: account.unit_balance,
      pendingUnits,
      status: account.status,
    },
    transactions,
  })
}
