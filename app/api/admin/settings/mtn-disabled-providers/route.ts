import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin as supabase } from "@/lib/supabase"

const VALID_PROVIDERS = ["sykes", "datakazina", "xpress", "eazyghdata", "bisdel", "codecraft", "agentportalgh", "apexprime"]

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const { data, error } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", "mtn_disabled_providers")
    .maybeSingle()

  if (error) return NextResponse.json({ error: "Failed to fetch setting" }, { status: 500 })

  return NextResponse.json({
    disabled: Array.isArray(data?.value?.providers) ? data.value.providers : [],
  })
}

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const body = await request.json()
  const { disabled } = body as { disabled: string[] }

  if (!Array.isArray(disabled) || disabled.some(p => !VALID_PROVIDERS.includes(p))) {
    return NextResponse.json({ error: "disabled must be an array of valid provider names" }, { status: 400 })
  }
  if (disabled.length >= VALID_PROVIDERS.length) {
    return NextResponse.json({ error: "Cannot deactivate every provider — at least one must stay active" }, { status: 400 })
  }

  const { error } = await supabase
    .from("admin_settings")
    .upsert({ key: "mtn_disabled_providers", value: { providers: disabled }, updated_at: new Date().toISOString() }, { onConflict: "key" })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, disabled })
}
