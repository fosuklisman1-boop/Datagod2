import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { getOrCreateAccountForUser } from "@/lib/sms/account-service"
import { listSenderIds, submitSenderId } from "@/lib/sms/sender-id-service"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/** Resolve the caller's SMS account from the bearer token, or an error response. */
async function resolveAccount(request: NextRequest) {
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
  return { account }
}

// GET /api/sms/sender-ids — the caller's own sender IDs
export async function GET(request: NextRequest) {
  const { account, error } = await resolveAccount(request)
  if (error) return error

  const result = await listSenderIds(account!.id)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 500 })
  return NextResponse.json({ success: true, data: result.data })
}

// POST /api/sms/sender-ids — request a new sender ID for the caller's account
// Body: { sender_id: string }
export async function POST(request: NextRequest) {
  const { account, error } = await resolveAccount(request)
  if (error) return error

  let body: { sender_id?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }
  if (!body.sender_id) {
    return NextResponse.json({ success: false, error: "sender_id is required" }, { status: 400 })
  }

  const result = await submitSenderId(body.sender_id, account!.id)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  return NextResponse.json({ success: true, data: result.data }, { status: 201 })
}
