/**
 * Shared auth + account resolution for tenant SMS routes (app/api/sms/*).
 * Bearer token -> Supabase user -> their sms_account. Returns { account, user }
 * or a ready-to-return { error } NextResponse (401/403). Every tenant route
 * scopes its DB work by account.id, so this is the single authz boundary.
 */

import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { getOrCreateAccountForUser } from "@/lib/sms/account-service"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

type SmsAccount = Awaited<ReturnType<typeof getOrCreateAccountForUser>>

export async function resolveAccount(
  request: NextRequest
): Promise<{ account: NonNullable<SmsAccount>; user: { id: string; email?: string }; error?: undefined } | { error: NextResponse; account?: undefined; user?: undefined }> {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 }) }
  }
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7))
  if (error || !user) {
    return { error: NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 }) }
  }
  const account = await getOrCreateAccountForUser(user.id)
  if (!account) {
    return { error: NextResponse.json({ success: false, error: "No SMS account for this user" }, { status: 403 }) }
  }
  return { account, user: { id: user.id, email: user.email } }
}
