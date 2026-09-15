import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin as supabase } from "@/lib/supabase"

const SETTING_KEY = "afa_provider_selection"
const VALID_PROVIDERS = ["sykes", "apexprime"] as const
type AfaProviderName = (typeof VALID_PROVIDERS)[number]

function isValidProvider(value: unknown): value is AfaProviderName {
  return typeof value === "string" && (VALID_PROVIDERS as readonly string[]).includes(value)
}

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const { data } = await supabase.from("admin_settings").select("value").eq("key", SETTING_KEY).maybeSingle()
    const raw = data?.value?.provider
    const provider: AfaProviderName = isValidProvider(raw) ? raw : "sykes"
    return NextResponse.json({ success: true, provider, availableProviders: VALID_PROVIDERS })
  } catch (error) {
    console.error("[AFA-PROVIDER-SETTING] GET error:", error)
    return NextResponse.json({ error: "Failed to fetch setting" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const { isAdmin, userId: adminId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const { provider } = await request.json()
    if (!isValidProvider(provider)) {
      return NextResponse.json({ error: `'provider' must be one of: ${VALID_PROVIDERS.join(", ")}` }, { status: 400 })
    }

    const { error } = await supabase.from("admin_settings").upsert(
      {
        key: SETTING_KEY,
        value: { provider },
        description: "Which provider handles new AFA (MTN AFA 4.0) registrations: sykes (synchronous) or apexprime (wallet-funded, async — confirmed later by the sync-afa-status/apexprime cron).",
        updated_at: new Date().toISOString(),
        updated_by: adminId,
      },
      { onConflict: "key" }
    )
    if (error) throw error

    console.log(`[AFA-PROVIDER-SETTING] set provider=${provider} by admin ${adminId}`)
    return NextResponse.json({ success: true, provider })
  } catch (error) {
    console.error("[AFA-PROVIDER-SETTING] POST error:", error)
    return NextResponse.json({ error: "Failed to update setting" }, { status: 500 })
  }
}
