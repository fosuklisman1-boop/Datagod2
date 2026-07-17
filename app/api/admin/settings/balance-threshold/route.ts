import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin as supabase } from "@/lib/supabase"

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "mtn_balance_alert_threshold")
    .maybeSingle()

  if (error) return NextResponse.json({ error: "Failed to fetch threshold" }, { status: 500 })

  return NextResponse.json({ threshold: parseInt(data?.value || "500", 10) })
}

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const { threshold } = await request.json()
  const value = parseInt(threshold, 10)

  if (isNaN(value) || value < 0) {
    return NextResponse.json({ error: "threshold must be a non-negative number" }, { status: 400 })
  }

  const { error } = await supabase
    .from("app_settings")
    .upsert({ key: "mtn_balance_alert_threshold", value: String(value) }, { onConflict: "key" })

  if (error) return NextResponse.json({ error: "Failed to update threshold" }, { status: 500 })

  console.log(`[balance-threshold] Updated to ₵${value}`)
  return NextResponse.json({ success: true, threshold: value })
}
