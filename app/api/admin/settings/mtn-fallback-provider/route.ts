import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin as supabase } from "@/lib/supabase"

const VALID_PROVIDERS = ["sykes", "datakazina", "xpress", "eazyghdata", "bisdel", "codecraft"]

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const { data, error } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", "mtn_fallback_provider")
    .maybeSingle()

  if (error) return NextResponse.json({ error: "Failed to fetch setting" }, { status: 500 })

  return NextResponse.json({
    enabled: data?.value?.enabled ?? false,
    provider: data?.value?.provider ?? "eazyghdata",
  })
}

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const body = await request.json()
  const { enabled, provider } = body as { enabled: boolean; provider: string }

  if (!VALID_PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: "Invalid provider" }, { status: 400 })
  }

  const { error } = await supabase
    .from("admin_settings")
    .upsert({ key: "mtn_fallback_provider", value: { enabled, provider }, updated_at: new Date().toISOString() }, { onConflict: "key" })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, enabled, provider })
}
