import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { isValidGhanaMobile, normalizeGhanaPhone } from "@/lib/phone-format"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

const SETTING_KEY = "results_check_admin_phones"
const SETTING_DESCRIPTION =
  "Ghana numbers (0XXXXXXXXX) of admins notified on WhatsApp for new Results Check requests; can claim & deliver via WhatsApp"

/**
 * GET /api/admin/results-check-requests/admin-phones
 * Returns the configured admin WhatsApp numbers for Results Check delivery.
 */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const { data, error } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", SETTING_KEY)
    .maybeSingle()

  if (error) {
    console.error("[RC-ADMIN-PHONES] Read error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const phones = Array.isArray(data?.value?.phones) ? data.value.phones : []
  return NextResponse.json({ success: true, phones })
}

/**
 * PUT /api/admin/results-check-requests/admin-phones
 * Body: { phones: string[] }
 */
export async function PUT(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const body = await request.json()
  const { phones } = body as { phones?: unknown }

  if (!Array.isArray(phones) || !phones.every(p => typeof p === "string")) {
    return NextResponse.json({ error: "'phones' must be an array of strings" }, { status: 400 })
  }

  const normalized: string[] = []
  for (const phone of phones) {
    if (!isValidGhanaMobile(phone)) {
      return NextResponse.json({ error: `Invalid Ghana number: ${phone}` }, { status: 400 })
    }
    const local = normalizeGhanaPhone(phone)!
    if (!normalized.includes(local)) normalized.push(local)
  }

  const { error } = await supabase
    .from("admin_settings")
    .upsert(
      {
        key: SETTING_KEY,
        value: { phones: normalized },
        description: SETTING_DESCRIPTION,
        updated_at: new Date().toISOString(),
        updated_by: userId,
      },
      { onConflict: "key" }
    )

  if (error) {
    console.error("[RC-ADMIN-PHONES] Upsert error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, phones: normalized })
}
