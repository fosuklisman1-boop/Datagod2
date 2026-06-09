import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

export const dynamic = "force-dynamic"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const SETTINGS_KEY = "results_check_settings"

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const { data } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", SETTINGS_KEY)
    .maybeSingle()

  const v = data?.value as any
  return NextResponse.json({
    enabled: v?.enabled !== false,
    fee: typeof v?.fee === "number" ? v.fee : 2.00,
  })
}

export async function PUT(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const body = await request.json() as { enabled?: boolean; fee?: number }

  const { data: existing } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", SETTINGS_KEY)
    .maybeSingle()

  const current = (existing?.value as any) ?? {}
  const updated = {
    enabled: body.enabled !== undefined ? body.enabled : (current.enabled !== false),
    fee: typeof body.fee === "number" ? body.fee : (typeof current.fee === "number" ? current.fee : 2.00),
  }

  const { error } = await supabase
    .from("admin_settings")
    .upsert(
      { key: SETTINGS_KEY, value: updated, description: "Results Check service settings", updated_at: new Date().toISOString() },
      { onConflict: "key" }
    )

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, ...updated })
}
