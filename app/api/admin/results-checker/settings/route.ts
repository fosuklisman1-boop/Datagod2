import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const RC_SETTING_KEYS = [
  "results_checker_price_waec",
  "results_checker_price_bece",
  "results_checker_price_novdec",
  "results_checker_enabled_waec",
  "results_checker_enabled_bece",
  "results_checker_enabled_novdec",
  "results_checker_max_markup_waec",
  "results_checker_max_markup_bece",
  "results_checker_max_markup_novdec",
  "results_checker_max_quantity",
  "results_checker_reservation_timeout",
]

export async function GET(request: NextRequest) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const { data, error } = await supabase
      .from("admin_settings")
      .select("key, value")
      .in("key", RC_SETTING_KEYS)

    if (error) throw error

    const settings = (data ?? []).reduce((acc: Record<string, any>, row) => {
      acc[row.key] = row.value
      return acc
    }, {})

    return NextResponse.json({ settings })
  } catch (err) {
    console.error("[RC-SETTINGS-GET] Error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const { settings } = await request.json()
    if (!settings) return NextResponse.json({ error: "No settings provided" }, { status: 400 })

    const results = await Promise.all(
      Object.entries(settings)
        .filter(([key]) => RC_SETTING_KEYS.includes(key))
        .map(([key, value]) =>
          supabase
            .from("admin_settings")
            .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" })
        )
    )

    const failed = results.filter(r => r.error)
    if (failed.length > 0) {
      console.error("[RC-SETTINGS-PUT] Errors:", failed.map(r => r.error))
      return NextResponse.json({ error: "Failed to update some settings" }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("[RC-SETTINGS-PUT] Error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
