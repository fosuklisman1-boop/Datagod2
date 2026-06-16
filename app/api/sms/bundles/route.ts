import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { getOrCreateAccountForUser } from "@/lib/sms/account-service"
import { listActiveBundles } from "@/lib/sms/bundle-service"
import type { OwnerType } from "@/lib/sms/foundation-rules"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7))
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const account = await getOrCreateAccountForUser(user.id)
  if (!account) return NextResponse.json({ error: "No SMS account" }, { status: 403 })
  const bundles = await listActiveBundles(account.owner_type as OwnerType)
  return NextResponse.json({ bundles })
}
