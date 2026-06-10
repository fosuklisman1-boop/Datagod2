import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// Curated public-config endpoint. admin_settings / app_settings are locked to
// service_role (they mix public config with sensitive keys like admin_alert_phone,
// mtn_provider_selection, etc.). This endpoint reads server-side with service-role
// and returns ONLY an explicit allowlist of non-sensitive config the storefront +
// dashboards need. The locked tables are never exposed wholesale to the browser.

export const dynamic = "force-dynamic"

// admin_settings key PREFIXES that are safe to expose (pricing / fees / enablement
// flags — all of which are already reflected in customer-facing prices).
const SAFE_ADMIN_PREFIXES = ["results_checker_", "airtime_", "results_check_"]

// app_settings COLUMNS that are safe to expose.
const SAFE_APP_COLUMNS = [
  "terms_content",
  "terms_last_updated",
  "ussd_shop_dial_code",
  "ussd_shop_activation_fee",
  "ussd_shop_session_price",
  "ussd_shop_min_sessions",
  "ussd_shop_max_sessions",
] as const

export async function GET() {
  try {
    const [adminRes, appRes] = await Promise.all([
      supabaseAdmin
        .from("admin_settings")
        .select("key, value")
        .or(SAFE_ADMIN_PREFIXES.map((p) => `key.like.${p}%`).join(",")),
      supabaseAdmin
        .from("app_settings")
        .select(SAFE_APP_COLUMNS.join(", "))
        .limit(1)
        .maybeSingle(),
    ])

    // Build admin_settings key→value map, defensively filtered to the allowlist
    const adminSettings: Record<string, any> = {}
    for (const row of adminRes.data ?? []) {
      if (SAFE_ADMIN_PREFIXES.some((p) => row.key?.startsWith(p))) {
        adminSettings[row.key] = row.value
      }
    }

    return NextResponse.json(
      {
        admin_settings: adminSettings,
        app_settings: appRes.data ?? {},
      },
      { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" } }
    )
  } catch (e) {
    console.error("[PUBLIC-CONFIG] Error:", e)
    return NextResponse.json({ admin_settings: {}, app_settings: {} }, { status: 200 })
  }
}
