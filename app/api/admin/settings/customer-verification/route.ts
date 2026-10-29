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
    const { enabled, providers, block_unverified } = await request.json()
    if (typeof enabled !== "boolean") {
      return NextResponse.json({ error: "'enabled' must be a boolean" }, { status: 400 })
    }
    if (!Array.isArray(providers)) {
      return NextResponse.json({ error: "'providers' must be an array" }, { status: 400 })
    }
    if (block_unverified !== undefined && typeof block_unverified !== "boolean") {
      return NextResponse.json({ error: "'block_unverified' must be a boolean" }, { status: 400 })
    }

    let validatedProviders: string[] = []
    if (providers.length > 0) {
      // Order matters here: it's the order the providers are asked in.
      const validation = validateProviderSelection(providers, undefined, { keepOrder: true })
      if (!validation.valid) {
        return NextResponse.json({ error: validation.error }, { status: 400 })
      }
      validatedProviders = validation.providers
    }

    // Omitted = keep what's stored, so an older client toggling `enabled` never clears it.
    const blockUnverified = block_unverified ?? (await getCustomerVerificationSettings()).block_unverified === true
    const newValue = { enabled, providers: validatedProviders, block_unverified: blockUnverified }
    const { error } = await supabase.from("admin_settings").upsert(
      {
        key: SETTING_KEY,
        value: newValue,
        description: "Independent, customer-facing live phone-verification preview shown at checkout — separate from the internal fulfillment-time whitelist gate (mtn_whitelist_enabled). block_unverified turns the warning into a hard block for numbers the selected providers reject.",
        updated_at: new Date().toISOString(),
        updated_by: adminId,
      },
      { onConflict: "key" }
    )
    if (error) throw error

    console.log(`[CUSTOMER-VERIFICATION-SETTING] set enabled=${enabled} block_unverified=${blockUnverified} providers=${validatedProviders.join(",")} by admin ${adminId}`)
    return NextResponse.json({ success: true, settings: newValue })
  } catch (error) {
    console.error("[CUSTOMER-VERIFICATION-SETTING] POST error:", error)
    return NextResponse.json({ error: "Failed to update setting" }, { status: 500 })
  }
}
