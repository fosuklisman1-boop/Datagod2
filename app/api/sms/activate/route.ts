// app/api/sms/activate/route.ts
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { getOrCreateAccountForUser } from "@/lib/sms/account-service"
import { activateViaWallet, initActivationPaystack } from "@/lib/sms/activation-service"

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

  const body = await request.json()
  const paidFrom: string = body?.paidFrom ?? "wallet"

  if (paidFrom === "wallet") {
    const result = await activateViaWallet(user.id, account.id)
    if (!result.ok) {
      const status = result.error === "INSUFFICIENT_BALANCE" ? 402 : 400
      return NextResponse.json({ error: result.error }, { status })
    }
    return NextResponse.json({ success: true })
  }

  if (paidFrom === "paystack") {
    if (!user.email) return NextResponse.json({ error: "Account email required for Paystack" }, { status: 400 })
    const result = await initActivationPaystack(user.id, account.id, user.email)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
    return NextResponse.json({ authorizationUrl: result.authorizationUrl, reference: result.reference })
  }

  return NextResponse.json({ error: "paidFrom must be 'wallet' or 'paystack'" }, { status: 400 })
}
