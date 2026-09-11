import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { listWhitelistProviders, validateProviderSelection } from "@/lib/mtn-providers/provider-whitelist"

const SETTING_KEY = "mtn_whitelist_switch_providers"

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const { data } = await supabase.from("admin_settings").select("value").eq("key", SETTING_KEY).maybeSingle()
    const providers = Array.isArray(data?.value?.providers) ? data.value.providers : []
    return NextResponse.json({
      success: true,
      providers,
      availableProviders: listWhitelistProviders(),
    })
  } catch (error) {
    console.error("[MTN-WHITELIST-SWITCH-SETTING] GET error:", error)
    return NextResponse.json({ error: "Failed to fetch setting" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const { isAdmin, userId: adminId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const { providers } = await request.json()
    if (!Array.isArray(providers)) {
      return NextResponse.json({ error: "'providers' must be an array" }, { status: 400 })
    }

    let validatedProviders: string[] = []
    if (providers.length > 0) {
      const validation = validateProviderSelection(providers)
      if (!validation.valid) {
        return NextResponse.json({ error: validation.error }, { status: 400 })
      }
      validatedProviders = validation.providers
    }

    const newValue = { providers: validatedProviders }
    const { error } = await supabase.from("admin_settings").upsert(
      {
        key: SETTING_KEY,
        value: newValue,
        description: "Which whitelist-registry providers may become the fulfilling provider via the order-time whitelist auto-switch (independent of mtn_disabled_providers, which also removes a provider from the whitelist check itself — this only gates whether an 'allowed' result from that provider can take over fulfillment).",
        updated_at: new Date().toISOString(),
        updated_by: adminId,
      },
      { onConflict: "key" }
    )
    if (error) throw error

    console.log(`[MTN-WHITELIST-SWITCH-SETTING] set providers=${validatedProviders.join(",")} by admin ${adminId}`)
    return NextResponse.json({ success: true, providers: validatedProviders })
  } catch (error) {
    console.error("[MTN-WHITELIST-SWITCH-SETTING] POST error:", error)
    return NextResponse.json({ error: "Failed to update setting" }, { status: 500 })
  }
}
