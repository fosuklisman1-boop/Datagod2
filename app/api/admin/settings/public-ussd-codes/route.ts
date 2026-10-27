import { NextRequest, NextResponse } from "next/server"
import { revalidateTag } from "next/cache"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { readPublicUssdCodes, validateUssdCodesInput, PUBLIC_USSD_SETTING_KEY } from "@/lib/seo/ussd-codes"

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const codes = await readPublicUssdCodes(supabase)
    return NextResponse.json({ codes })
  } catch {
    return NextResponse.json({ error: "Failed to load USSD codes" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const result = validateUssdCodesInput(body)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })

  const { error } = await supabase
    .from("app_settings")
    .upsert({ key: PUBLIC_USSD_SETTING_KEY, value: JSON.stringify(result.value) }, { onConflict: "key" })

  if (error) return NextResponse.json({ error: "Failed to update USSD codes" }, { status: 500 })

  revalidateTag("seo-live-facts")
  console.log(`[public-ussd-codes] Updated: main=${result.value.main ?? "-"} shop=${result.value.shop ?? "-"}`)
  return NextResponse.json({ success: true, codes: result.value })
}
