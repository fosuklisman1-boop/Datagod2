import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { listWhitelistProviders, validateProviderSelection } from "@/lib/mtn-providers/provider-whitelist"
import { getCustomerVerificationSettings, SETTING_KEY } from "@/lib/mtn-providers/customer-verification"

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const settings = await getCustomerVerificationSettings()
    return NextResponse.json({
      success: true,
      settings,
      availableProviders: listWhitelistProviders(),
    })
  } catch (error) {
    console.error("[CUSTOMER-VERIFICATION-SETTING] GET error:", error)
    return NextResponse.json({ error: "Failed to fetch setting" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const { isAdmin, userId: adminId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const { enabled, providers } = await request.json()
    if (typeof enabled !== "boolean") {
      return NextResponse.json({ error: "'enabled' must be a boolean" }, { status: 400 })
    }
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

    const newValue = { enabled, providers: validatedProviders }
    const { error } = await supabase.from("admin_settings").upsert(
      {
        key: SETTING_KEY,
        value: newValue,
        description: "Independent, customer-facing live phone-verification preview shown at checkout — separate from the internal fulfillment-time whitelist gate (mtn_whitelist_enabled).",
        updated_at: new Date().toISOString(),
        updated_by: adminId,
      },
      { onConflict: "key" }
    )
    if (error) throw error

    console.log(`[CUSTOMER-VERIFICATION-SETTING] set enabled=${enabled} providers=${validatedProviders.join(",")} by admin ${adminId}`)
    return NextResponse.json({ success: true, settings: newValue })
  } catch (error) {
    console.error("[CUSTOMER-VERIFICATION-SETTING] POST error:", error)
    return NextResponse.json({ error: "Failed to update setting" }, { status: 500 })
  }
}
