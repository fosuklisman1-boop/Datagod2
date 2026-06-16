import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { getOrCreateAccountForUser } from "@/lib/sms/account-service"
import { initializePayment } from "@/lib/paystack"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7))
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!user.email) return NextResponse.json({ error: "Account email required" }, { status: 400 })
  const { bundleId } = await request.json()
  const account = await getOrCreateAccountForUser(user.id)
  if (!account) return NextResponse.json({ error: "No SMS account" }, { status: 403 })
  const { data: bundle } = await supabaseAdmin.from("sms_bundles").select("*").eq("id", bundleId).maybeSingle()
  if (!bundle || !bundle.active) return NextResponse.json({ error: "Bundle not available" }, { status: 400 })
  const reference = `smsbundle-${account.id}-${bundleId}-${Date.now()}`
  const init = await initializePayment({
    email: user.email,
    amount: Number(bundle.price_ghs),
    reference,
    purpose: "SMS Bundle",
    metadata: { type: "sms_bundle", sms_account_id: account.id, units: bundle.units, bundle_id: bundleId },
  })
  return NextResponse.json({ authorizationUrl: init.authorizationUrl, reference })
}
