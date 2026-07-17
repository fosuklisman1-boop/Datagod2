import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin as supabase } from "@/lib/supabase"

const NETWORK_KEYS: Record<string, string> = {
  telecel: "telecel_provider_selection",
  at_ishare: "at_ishare_provider_selection",
  at_bigtime: "at_bigtime_provider_selection",
}

const VALID_PROVIDERS = ["datakazina", "xpress", "eazyghdata", "codecraft"]

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const network = request.nextUrl.searchParams.get("network")
  const settingKey = network ? NETWORK_KEYS[network] : undefined
  if (!settingKey) {
    return NextResponse.json({ error: "Invalid network. Use: telecel, at_ishare, at_bigtime" }, { status: 400 })
  }

  const { data, error } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", settingKey)
    .maybeSingle()

  if (error) {
    console.error("[network-provider] GET error:", error)
    return NextResponse.json({ error: "Failed to fetch setting" }, { status: 500 })
  }

  return NextResponse.json({ provider: data?.value?.provider || "codecraft", success: true })
}

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const { network, provider } = await request.json()
  const settingKey = network ? NETWORK_KEYS[network] : undefined
  if (!settingKey) {
    return NextResponse.json({ error: "Invalid network. Use: telecel, at_ishare, at_bigtime" }, { status: 400 })
  }
  if (!VALID_PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: `Invalid provider. Use: ${VALID_PROVIDERS.join(", ")}` }, { status: 400 })
  }

  const { error } = await supabase
    .from("admin_settings")
    .upsert({ key: settingKey, value: { provider }, updated_at: new Date().toISOString() }, { onConflict: "key" })

  if (error) {
    console.error("[network-provider] POST error:", error)
    return NextResponse.json({ error: "Failed to update setting" }, { status: 500 })
  }

  console.log(`[network-provider] ${network} provider set to: ${provider}`)
  return NextResponse.json({ success: true, network, provider })
}
