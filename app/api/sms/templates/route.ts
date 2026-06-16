import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { getOrCreateAccountForUser } from "@/lib/sms/account-service"
import { listTenantTemplates, createTenantTemplate } from "@/lib/sms/tenant-templates-service"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function resolveAccount(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 }) }
  }
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7))
  if (error || !user) return { error: NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 }) }
  const account = await getOrCreateAccountForUser(user.id)
  if (!account) return { error: NextResponse.json({ success: false, error: "No SMS account for this user" }, { status: 403 }) }
  return { account }
}

// GET /api/sms/templates — the caller's own templates
export async function GET(request: NextRequest) {
  const { account, error } = await resolveAccount(request)
  if (error) return error
  const result = await listTenantTemplates(account!.id)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 500 })
  return NextResponse.json({ success: true, data: result.data })
}

// POST /api/sms/templates — save a template  { name, body }
export async function POST(request: NextRequest) {
  const { account, error } = await resolveAccount(request)
  if (error) return error
  let body: { name?: string; body?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }
  if (!body.name || !body.body) {
    return NextResponse.json({ success: false, error: "name and body are required" }, { status: 400 })
  }
  const result = await createTenantTemplate(account!.id, body.name, body.body)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  return NextResponse.json({ success: true, data: result.data }, { status: 201 })
}
