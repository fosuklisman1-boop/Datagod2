import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { getOrCreateAccountForUser } from "@/lib/sms/account-service"
import { purchaseBundleViaWallet } from "@/lib/sms/bundle-service"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7))
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { bundleId } = await request.json()
  if (!bundleId) return NextResponse.json({ error: "bundleId required" }, { status: 400 })
  const account = await getOrCreateAccountForUser(user.id)
  if (!account) return NextResponse.json({ error: "No SMS account" }, { status: 403 })
  const result = await purchaseBundleViaWallet(user.id, account.id, bundleId)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json({ success: true, pending: result.pending ?? false, unitsCredited: result.unitsCredited ?? 0 })
}
