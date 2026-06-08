// app/api/admin/airtime/digiwapy-debug/route.ts
// Temporary debug endpoint — remove once auto-fulfillment is confirmed working
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { isDigiWapyConfigured } from "@/lib/digiwapy-provider"

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const keys = [
    "airtime_digiwapy_enabled_mtn",
    "airtime_digiwapy_enabled_telecel",
    "airtime_digiwapy_enabled_at",
  ]

  const { data, error } = await supabase
    .from("admin_settings")
    .select("key, value")
    .in("key", keys)

  const toggleMap = (data ?? []).reduce((acc: any, row) => {
    acc[row.key] = row.value
    return acc
  }, {})

  return NextResponse.json({
    configured: isDigiWapyConfigured(),
    env: {
      DIGIWAPY_API_KEY: process.env.DIGIWAPY_API_KEY ? `set (${process.env.DIGIWAPY_API_KEY.slice(0, 4)}...)` : "MISSING",
      DIGIWAPY_PARTNER_CODE: process.env.DIGIWAPY_PARTNER_CODE ? `set (${process.env.DIGIWAPY_PARTNER_CODE.slice(0, 4)}...)` : "MISSING",
    },
    toggles: {
      mtn: toggleMap["airtime_digiwapy_enabled_mtn"] ?? "ROW MISSING",
      telecel: toggleMap["airtime_digiwapy_enabled_telecel"] ?? "ROW MISSING",
      at: toggleMap["airtime_digiwapy_enabled_at"] ?? "ROW MISSING",
    },
    db_error: error?.message ?? null,
  })
}
