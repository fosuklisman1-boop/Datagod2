import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin as supabase } from "@/lib/supabase"

const VALID_PROVIDERS = ["sykes", "datakazina", "xpress", "eazyghdata", "bisdel", "codecraft", "agentportalgh"]

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const { data, error } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", "mtn_retry_sequence")
    .maybeSingle()

  if (error) return NextResponse.json({ error: "Failed to fetch setting" }, { status: 500 })

  return NextResponse.json({
    enabled: data?.value?.enabled ?? false,
    providers: Array.isArray(data?.value?.providers) ? data.value.providers : [],
  })
}

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const body = await request.json()
  const { enabled, providers } = body as { enabled: boolean; providers: string[] }

  if (!Array.isArray(providers) || providers.some(p => !VALID_PROVIDERS.includes(p))) {
    return NextResponse.json({ error: "providers must be an array of valid provider names" }, { status: 400 })
  }

  const { error } = await supabase
    .from("admin_settings")
    .upsert({ key: "mtn_retry_sequence", value: { enabled, providers }, updated_at: new Date().toISOString() }, { onConflict: "key" })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, enabled, providers })
}
