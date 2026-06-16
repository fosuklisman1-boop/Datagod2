// app/api/sms/claim-bonus/route.ts
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { getOrCreateAccountForUser } from "@/lib/sms/account-service"
import { claimWelcomeBonus } from "@/lib/sms/activation-service"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7))
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const account = await getOrCreateAccountForUser(user.id)
  if (!account) return NextResponse.json({ error: "No SMS account" }, { status: 403 })

  // The welcome bonus is a tenant (shop/sub-agent) perk. The platform/admin
  // account runs free, un-metered broadcasts and doesn't get one.
  if (account.owner_type === "platform") {
    return NextResponse.json({ error: "BONUS_NOT_APPLICABLE" }, { status: 400 })
  }

  // Only active accounts may claim the bonus.
  if (account.status !== "active") {
    return NextResponse.json({ error: "NOT_ACTIVATED" }, { status: 403 })
  }

  const result = await claimWelcomeBonus(account.id)
  if (!result.ok) {
    const status = result.error === "ALREADY_CLAIMED" ? 409 : 400
    return NextResponse.json({ error: result.error }, { status })
  }

  return NextResponse.json({
    success: true,
    pending: result.pending ?? false,
    unitsCredited: result.unitsCredited ?? 0,
  })
}
