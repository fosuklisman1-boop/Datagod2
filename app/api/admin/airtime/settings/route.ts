import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

// Supabase client will be initialized inside handlers

const AIRTIME_SETTING_KEYS = [
  "airtime_fee_mtn_customer",
  "airtime_fee_mtn_dealer",
  "airtime_fee_telecel_customer",
  "airtime_fee_telecel_dealer",
  "airtime_fee_at_customer",
  "airtime_fee_at_dealer",
  "airtime_fee_mtn_sub_agent",
  "airtime_fee_telecel_sub_agent",
  "airtime_fee_at_sub_agent",
  "airtime_min_amount",
  "airtime_max_amount",
  "airtime_enabled_mtn",
  "airtime_enabled_telecel",
  "airtime_enabled_at",
]

export async function GET(request: NextRequest) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { data, error } = await supabase
      .from("admin_settings")
      .select("key, value")
      .in("key", AIRTIME_SETTING_KEYS)

    if (error) throw error

    // Transform from array to object
    const settings = (data || []).reduce((acc: any, item) => {
      acc[item.key] = item.value
      return acc
    }, {})

    return NextResponse.json({ settings })
  } catch (error) {
    console.error("[AIRTIME-SETTINGS-GET] Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { settings } = await request.json()
    if (!settings) return NextResponse.json({ error: "No settings provided" }, { status: 400 })

    const promises = Object.entries(settings).map(([key, value]) => {
      if (!AIRTIME_SETTING_KEYS.includes(key)) return Promise.resolve()
      
      return supabase
        .from("admin_settings")
        .upsert({ 
          key, 
          value, 
          updated_at: new Date().toISOString() 
        }, { onConflict: "key" })
    })

    const results = await Promise.all(promises)
    const errors = results.filter(r => r && (r as any).error)
    if (errors.length > 0) {
      console.error("[AIRTIME-SETTINGS-PUT] Errors:", errors)
      return NextResponse.json({ error: "Failed to update some settings" }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[AIRTIME-SETTINGS-PUT] Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
