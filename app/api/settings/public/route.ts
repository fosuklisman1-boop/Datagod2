import { NextResponse } from "next/server"
import { supabase } from "@/lib/supabase"

// Public endpoint to expose global feature toggles to the frontend
export async function GET() {
  try {
    const { data, error } = await supabase
      .from("app_settings")
      .select("signups_enabled, wallet_topups_enabled, upgrades_enabled")
      .single()

    if (error) {
      console.error("[PUBLIC_SETTINGS] Database error:", error)
      // Fallback to true if there's an issue fetching
      return NextResponse.json({
        signups_enabled: true,
        wallet_topups_enabled: true,
        upgrades_enabled: true,
      })
    }

    return NextResponse.json({
      signups_enabled: data?.signups_enabled ?? true,
      wallet_topups_enabled: data?.wallet_topups_enabled ?? true,
      upgrades_enabled: data?.upgrades_enabled ?? true,
    })
  } catch (error) {
    console.error("[PUBLIC_SETTINGS] Internal error:", error)
    return NextResponse.json({
      signups_enabled: true,
      wallet_topups_enabled: true,
      upgrades_enabled: true,
    })
  }
}
